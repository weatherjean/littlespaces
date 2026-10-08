use crate::{
    store::{text, Result, Store},
    vault,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};
pub(crate) mod operations;
use operations::Operation;

fn public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || b == 0 || b == 2))
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}
fn reference(store: &Store, value: &Value, origin: &str) -> Result<String> {
    if let Some(s) = value.as_str() {
        return Ok(s.into());
    }
    let name = text(value, "secret");
    if name.is_empty() {
        return Err("Invalid credential reference".into());
    }
    Ok(format!(
        "{}{}",
        text(value, "prefix"),
        vault::for_origin(store, name, origin)?
    ))
}
pub struct Authority<'a> {
    pub store: &'a crate::store::Store,
    pub applet_id: &'a str,
    pub http: &'a serde_json::Value,
    pub read_only: bool,
    pub version: Option<i64>,
}
/// Authorize each bridge request independently of the JavaScript wrapper.
/// Persist write intent before dispatch; cancellation leaves an uncertain outcome.
pub async fn request_for_action(
    authority: &Authority<'_>,
    action: &str,
    input: &Value,
    diagnostics: &mut Vec<Value>,
) -> Result<Value> {
    let grants = crate::capabilities::grants(authority.store, authority.applet_id)?;
    crate::capabilities::check(&grants, input)?;
    crate::capabilities::check(authority.http, input)?;
    let method = if text(input, "method").is_empty() {
        "GET".to_string()
    } else {
        text(input, "method").to_uppercase()
    };
    let external_write = !matches!(method.as_str(), "GET" | "HEAD");
    if external_write && authority.read_only {
        return Err("This action cannot use that HTTP method".into());
    }
    let operation = if external_write {
        let version = authority
            .version
            .ok_or("External writes require a revision-bound action")?;
        let origin = url::Url::parse(text(input, "url"))
            .map_err(|_| "Invalid API URL")?
            .origin()
            .ascii_serialization();
        Some(Operation::begin(
            authority.store,
            authority.applet_id,
            version,
            action,
            &origin,
            &method,
        )?)
    } else {
        None
    };
    let event = diagnostics.len();
    if let Some(operation) = &operation {
        diagnostics.push(json!({"operationId":operation.id,"code":"external_write","outcome":"uncertain","version":authority.version,"automaticRetry":false}));
    }
    let result = request_with_operation(
        authority.store,
        input,
        authority.read_only,
        operation.as_ref(),
    )
    .await;
    if let Some(operation) = &operation {
        if let Ok(evidence) = operation.evidence() {
            diagnostics[event]["outcome"] = evidence["status"].clone();
            diagnostics[event]["responseState"] = evidence["response_state"].clone();
            diagnostics[event]["httpStatus"] = evidence["http_status"].clone();
        }
    }
    result
}

pub async fn request(store: &Store, input: &Value, read_only: bool) -> Result<Value> {
    request_with_operation(store, input, read_only, None).await
}

async fn request_with_operation(
    store: &Store,
    input: &Value,
    read_only: bool,
    operation: Option<&Operation<'_>>,
) -> Result<Value> {
    let mut url = url::Url::parse(text(input, "url")).map_err(|_| "Invalid API URL")?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Use a public HTTPS endpoint on port 443".into());
    }
    let origin = url.origin().ascii_serialization();
    let mut credentials = Vec::new();
    for section in ["headers", "query"] {
        if let Some(values) = input[section].as_object() {
            for value in values.values() {
                if !text(value, "secret").is_empty() {
                    credentials.push(vault::for_origin(store, text(value, "secret"), &origin)?);
                }
            }
        }
    }

    let host = url.host_str().ok_or("Missing API hostname")?.to_string();
    let method = if text(input, "method").is_empty() {
        "GET".into()
    } else {
        text(input, "method").to_uppercase()
    };
    if !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str())
        || (read_only && !matches!(method.as_str(), "GET" | "HEAD"))
    {
        return Err("This action cannot use that HTTP method".into());
    }
    if let Some(query) = input["query"].as_object() {
        if query.len() > 30 {
            return Err("Too many query fields".into());
        }
        for (key, value) in query {
            let value = reference(store, value, &origin)?;
            url.query_pairs_mut().append_pair(key, &value);
        }
    }
    let addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host.as_str(), 443)),
    )
    .await
    .map_err(|_| "API DNS lookup timed out")?
    .map_err(|_| "API DNS lookup failed")?
    .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses.iter().any(|addr| match addr.ip() {
            IpAddr::V4(ip) => !public(ip),
            IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.segments()[0] & 0xfe00 == 0xfc00
                    || ip.segments()[0] & 0xffc0 == 0xfe80
            }
        })
    {
        return Err("API endpoint resolves to a private or reserved address".into());
    }
    let address = addresses
        .into_iter()
        .find(|a| a.is_ipv4())
        .ok_or("API needs a public IPv4 endpoint")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .resolve(&host, SocketAddr::new(address.ip(), 443))
        .build()
        .map_err(|_| "Cannot start API client")?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid method")?;
    let mut req = client.request(method, url);
    if let Some(headers) = input["headers"].as_object() {
        if headers.len() > 30 {
            return Err("Too many headers".into());
        }
        for (name, value) in headers {
            let lower = name.to_lowercase();
            if [
                "host",
                "connection",
                "forwarded",
                "transfer-encoding",
                "content-length",
                "proxy-authorization",
            ]
            .contains(&lower.as_str())
                || lower.starts_with("x-forwarded")
            {
                return Err("Routing headers are unavailable".into());
            }
            req = req.header(name, reference(store, value, &origin)?);
        }
    }
    if !input["body"].is_null() {
        if input["body"].to_string().len() > 128 * 1024 {
            return Err("API body is too large".into());
        }
        req = req.json(&input["body"]);
    }
    if let Some(operation) = operation {
        operation.dispatched()?;
    }
    let response = req
        .send()
        .await
        .map_err(|_| "API request failed or timed out; inspect the app before retrying a write")?;
    read_response(response, &credentials, operation).await
}

pub(crate) async fn read_response(
    response: reqwest::Response,
    credentials: &[String],
    operation: Option<&Operation<'_>>,
) -> Result<Value> {
    let status = response.status();
    if let Some(operation) = operation {
        operation.received(status.as_u16())?;
    }
    if status.is_redirection() {
        if let Some(operation) = operation {
            operation.body_state("redirect_blocked")?;
        }
        return Err("API redirects are blocked; use the final public endpoint".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                if let Some(operation) = operation {
                    operation.body_state("body_failed")?;
                }
                return Err("API response failed".into());
            }
        };
        if bytes.len() + chunk.len() > 1_000_000 {
            if let Some(operation) = operation {
                operation.body_state("body_too_large")?;
            }
            return Err("API response exceeds 1 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut data = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    redact(&mut data, credentials);
    if let Some(operation) = operation {
        operation.body_state("body_received")?;
    }
    Ok(json!({"status":status.as_u16(),"ok":status.is_success(),"data":data}))
}
// API responses are untrusted. Providers can echo credentials in JSON keys as well as values.
fn redact_text(text: &mut String, credentials: &[String]) {
    for credential in credentials
        .iter()
        .filter(|credential| !credential.is_empty())
    {
        *text = text.replace(credential, "[redacted]");
        let encoded =
            url::form_urlencoded::byte_serialize(credential.as_bytes()).collect::<String>();
        *text = text.replace(&encoded, "[redacted]");
    }
}

fn redact(value: &mut Value, credentials: &[String]) {
    match value {
        Value::String(text) => redact_text(text, credentials),
        Value::Array(values) => {
            for value in values {
                redact(value, credentials);
            }
        }
        Value::Object(values) => {
            let entries = std::mem::take(values);
            for (mut key, mut value) in entries {
                redact_text(&mut key, credentials);
                redact(&mut value, credentials);
                values.insert(key, value);
            }
        }
        _ => {}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserved_addresses_are_blocked() {
        for ip in [
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.1",
            "224.0.0.1",
        ] {
            assert!(!public(ip.parse().unwrap()));
        }
        assert!(public("1.1.1.1".parse().unwrap()));
    }
}

#[cfg(test)]
mod redaction_tests {
    use super::*;

    #[test]
    fn echoed_credentials_are_redacted_in_nested_keys_and_values() {
        let secret = "synthetic/credential+value";
        let encoded = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>();
        let mut response = json!({
            secret: [{encoded.clone(): {"message": format!("Bearer {secret}")}}],
            "encoded": encoded,
            "public": "unchanged",
        });
        redact(&mut response, &[secret.into()]);
        assert_eq!(
            response,
            json!({
                "[redacted]": [{"[redacted]": {"message": "Bearer [redacted]"}}],
                "encoded": "[redacted]",
                "public": "unchanged",
            })
        );
    }
}

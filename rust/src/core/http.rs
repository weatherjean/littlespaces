use super::{control::Control, secrets::Secrets, *};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, Value>,
    #[serde(default)]
    pub query: BTreeMap<String, Value>,
    #[serde(default)]
    pub body: Option<Value>,
}
#[derive(Clone, Default)]
pub struct MockHttp(pub BTreeMap<String, Value>);
#[derive(Clone)]
pub(crate) struct Broker {
    pub store: Store,
    pub secrets: Secrets,
    pub handle: tokio::runtime::Handle,
}
impl Broker {
    pub fn request(
        &self,
        invocation: &InvocationId,
        request: HttpRequest,
        readonly: bool,
        mock: Option<&MockHttp>,
        control: &Control,
    ) -> Result<Value> {
        control.check()?;
        if !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(&request.method.as_str()) {
            return Err(Error::Validation);
        }
        let write = !matches!(request.method.as_str(), "GET" | "HEAD");
        if write && readonly {
            return Err(Error::ReadOnly);
        }
        if request.headers.len() > 30
            || request.query.len() > 30
            || serde_json::to_vec(&request)
                .map_err(|_| Error::Validation)?
                .len()
                > 32768
        {
            return Err(Error::Limit);
        }
        // URL/keys are never substituted. Only structured header/query/body values are.
        let scope = self.secrets.scope()?;
        let headers = scope.resolve(&json!(request.headers), mock.is_some())?;
        let query = scope.resolve(&json!(request.query), mock.is_some())?;
        let body = scope.resolve(&json!(request.body), mock.is_some())?;
        if headers.to_string().len() + query.to_string().len() + body.to_string().len() > 65536 {
            return Err(Error::Limit);
        }
        if let Some(mock) = mock {
            let result = mock.0.get(&request.url).cloned().ok_or(Error::Network)?;
            if result.to_string().len() > 65536 {
                return Err(Error::Limit);
            }
            return scope.redact(result);
        }
        let mut url = url::Url::parse(&request.url).map_err(|_| Error::Network)?;
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Network);
        }
        for (k, v) in query.as_object().ok_or(Error::Validation)? {
            url.query_pairs_mut()
                .append_pair(k, v.as_str().ok_or(Error::Validation)?);
        }
        // This outer deadline includes DNS, TLS, dispatch and streaming body reads.
        let operation=self.handle.block_on(async {
            tokio::select! {
                biased;
                _=control.cancelled()=>Err(Error::Cancelled),
                result=tokio::time::timeout_at(tokio::time::Instant::from_std(control.deadline),self.send(invocation,url,&request.method,&headers,&body,write))=>result.unwrap_or(Err(Error::Deadline)),
            }
        });
        operation.and_then(|value| scope.redact(value))
    }
    async fn send(
        &self,
        invocation: &InvocationId,
        url: url::Url,
        method: &str,
        headers: &Value,
        body: &Value,
        write: bool,
    ) -> Result<Value> {
        let host = url.host_str().ok_or(Error::Network)?;
        let addresses = tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::lookup_host((host, 443)),
        )
        .await
        .map_err(|_| Error::Network)?
        .map_err(|_| Error::Network)?
        .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
            return Err(Error::Network);
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(500))
            .connect_timeout(Duration::from_millis(250))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| Error::Network)?;
        let mut req = client.request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| Error::Validation)?,
            url,
        );
        for (k, v) in headers.as_object().ok_or(Error::Validation)? {
            let lower = k.to_ascii_lowercase();
            if [
                "host",
                "connection",
                "forwarded",
                "transfer-encoding",
                "content-length",
                "proxy-authorization",
                "upgrade",
                "te",
                "trailer",
            ]
            .contains(&lower.as_str())
                || lower.starts_with("x-forwarded")
            {
                return Err(Error::Validation);
            }
            let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                .map_err(|_| Error::Validation)?;
            let value =
                reqwest::header::HeaderValue::from_str(v.as_str().ok_or(Error::Validation)?)
                    .map_err(|_| Error::Validation)?;
            req = req.header(name, value);
        }
        if !body.is_null() {
            req = req.json(body);
        }
        let req = req.build().map_err(|_| Error::Validation)?;
        self.dispatch(invocation, client, req, method, write).await
    }
    async fn dispatch(
        &self,
        invocation: &InvocationId,
        client: reqwest::Client,
        req: reqwest::Request,
        method: &str,
        write: bool,
    ) -> Result<Value> {
        let operation = if write {
            Some(format!("{:032x}", rand::random::<u128>()))
        } else {
            None
        };
        // Blocking persistence stays on the action thread, even while this async transport runs.
        // It records uncertainty before dispatch so dropping this future cannot erase evidence.
        if let Some(id) = &operation {
            self.store.open()?.execute(
                "INSERT INTO external_operations VALUES(?,?,?,'uncertain',NULL)",
                params![id, invocation.0, method],
            )?;
        }
        let mut response = client.execute(req).await.map_err(|_| {
            if write {
                Error::ExternalUncertain
            } else {
                Error::Network
            }
        })?;
        let status = response.status().as_u16();
        if let Some(id) = &operation {
            self.store.open()?.execute(
                "UPDATE external_operations SET status=? WHERE id=?",
                params![status, id],
            )?;
        }
        if response.status().is_redirection() {
            return Err(if write {
                Error::ExternalUncertain
            } else {
                Error::Network
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            if write {
                Error::ExternalUncertain
            } else {
                Error::Network
            }
        })? {
            if bytes.len() + chunk.len() > 65536 {
                return Err(if write {
                    Error::ExternalUncertain
                } else {
                    Error::Limit
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| {
                if write {
                    Error::ExternalUncertain
                } else {
                    Error::Network
                }
            })?
        };
        if let Some(id) = &operation {
            self.store.open()?.execute(
                "UPDATE external_operations SET state='response_received' WHERE id=?",
                [id],
            )?;
        }
        // An HTTP status is evidence, not proof that a service rolled back or applied a write.
        Ok(json!({"status":status,"body":value}))
    }
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || b == 0 || b == 2 || b == 88 && c == 99))
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19 || b == 51 && c == 100))
        || (a == 203 && b == 0 && c == 113))
}
pub fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        // Conservative global-unicast range; exclude transition/documentation special ranges.
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn fixture() -> (tempfile::TempDir, Broker, InvocationId) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets = Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
        let app = store.create_app("Evidence").unwrap();
        let draft = store
            .create_draft(
                &app,
                AppCode {
                    backend: "fn run(input) { [] }".into(),
                    frontend: "".into(),
                    actions: vec![ActionContract {
                        name: "run".into(),
                        read_only: false,
                        input: json!({}),
                        output: json!({}),
                    }],
                    tests: vec![],
                },
            )
            .unwrap();
        let revision = store.freeze_draft(&draft.id, 1).unwrap();
        let id = InvocationId::new();
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO invocations VALUES(?,?,?,'run','running')",
                params![id.0, app.0, revision.id.0],
            )
            .unwrap();
        (
            dir,
            Broker {
                store,
                secrets,
                handle: tokio::runtime::Handle::current(),
            },
            id,
        )
    }
    fn slow_server() -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0u8; 4096];
            let _ = stream.read(&mut bytes);
            // Deliver headers, then stall the body; total transport timeout must include both.
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
            std::thread::sleep(Duration::from_millis(150));
            let _ = stream.write_all(b"{}");
        });
        (format!("http://{address}"), thread)
    }
    #[tokio::test]
    async fn slow_body_timeout_preserves_ambiguous_write_evidence() {
        let (_dir, broker, id) = fixture();
        let (url, server) = slow_server();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(40))
            .build()
            .unwrap();
        let request = client.post(url).build().unwrap();
        let start = std::time::Instant::now();
        assert_eq!(
            broker.dispatch(&id, client, request, "POST", true).await,
            Err(Error::ExternalUncertain)
        );
        assert!(start.elapsed() < Duration::from_millis(140));
        let (state, status): (String, i64) = broker
            .store
            .open()
            .unwrap()
            .query_row(
                "SELECT state,status FROM external_operations WHERE invocation=?",
                [&id.0],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "uncertain");
        assert_eq!(status, 200);
        server.join().unwrap();
    }
    #[tokio::test]
    async fn dropping_transport_future_cannot_erase_pre_dispatch_evidence() {
        let (_dir, broker, id) = fixture();
        let (url, server) = slow_server();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
        let request = client.post(url).build().unwrap();
        assert!(tokio::time::timeout(
            Duration::from_millis(35),
            broker.dispatch(&id, client, request, "POST", true)
        )
        .await
        .is_err());
        let state: String = broker
            .store
            .open()
            .unwrap()
            .query_row(
                "SELECT state FROM external_operations WHERE invocation=?",
                [&id.0],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "uncertain");
        server.join().unwrap();
    }
    #[test]
    fn public_network_filter_rejects_private_reserved_and_transition_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.1",
            "198.18.0.1",
            "203.0.113.5",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "64:ff9b::7f00:1",
            "3fff::1",
        ] {
            assert!(!public_address(address.parse().unwrap()), "{address}");
        }
        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_address(address.parse().unwrap()));
        }
    }
}

//! Direct supported Sign in with ChatGPT. No Codex cache, executable, or browser token storage.
use super::{
    owner::{now, token},
    secrets::Secrets,
    *,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use zeroize::{Zeroize, Zeroizing};
const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const JWKS: &str = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE: &str = "https://api.openai.com/v1";
#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    subject: String,
    email: Option<String>,
    client_id: String,
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_at: i64,
    scope: String,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    id_token: String,
    expires_in: i64,
    #[serde(default)]
    scope: String,
    token_type: String,
}
impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}
#[derive(Clone)]
struct Attempt {
    state: String,
    verifier: String,
    nonce: String,
    redirect: String,
    owner: String,
    expires: i64,
    client_id: Option<String>,
    subject: Option<String>,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        self.verifier.zeroize();
        self.nonce.zeroize();
        self.state.zeroize();
    }
}
#[derive(Deserialize)]
struct Identity {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    nonce: String,
    iat: i64,
}
#[derive(Clone)]
pub struct ChatGpt {
    store: Store,
    secrets: Secrets,
    client: reqwest::Client,
    pending: Arc<tokio::sync::Mutex<Option<Attempt>>>,
    gate: Arc<tokio::sync::Mutex<()>>,
}
impl ChatGpt {
    pub fn new(store: Store, secrets: Secrets) -> Result<Self> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| Error::Network)?;
        Ok(Self {
            store,
            secrets,
            client,
            pending: Arc::new(tokio::sync::Mutex::new(None)),
            gate: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
    async fn saved(&self) -> Result<Option<Credentials>> {
        let secrets = self.secrets.clone();
        self.store
            .blocking(move |store| {
                let encrypted: Option<Vec<u8>> = store
                    .open()?
                    .query_row("SELECT ciphertext FROM chatgpt_auth WHERE id=1", [], |r| {
                        r.get(0)
                    })
                    .optional()?;
                encrypted
                    .map(|bytes| {
                        serde_json::from_slice(&secrets.unseal("chatgpt_auth", &bytes)?)
                            .map_err(|_| Error::Storage)
                    })
                    .transpose()
            })
            .await
    }
    async fn save(&self, credentials: Credentials) -> Result<()> {
        let secrets = self.secrets.clone();
        self.store.blocking(move |store| {
            let bytes=Zeroizing::new(serde_json::to_vec(&credentials).map_err(|_|Error::Storage)?);
            let encrypted=secrets.seal("chatgpt_auth",&bytes)?;
            let mut db=store.open()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute("INSERT INTO chatgpt_auth VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext",[encrypted])?;
            tx.execute("INSERT INTO chatgpt_registration VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,client_id=excluded.client_id,email=excluded.email",rusqlite::params![credentials.subject,credentials.client_id,credentials.email])?;
            tx.commit()?;Ok(())
        }).await
    }
    pub async fn status(&self) -> Result<Value> {
        Ok(match self.saved().await? {
            Some(c) => {
                json!({"connected":true,"email":c.email,"planUsage":c.scope.split_whitespace().any(|s|s=="chatgpt.tokens.use.direct")})
            }
            None => json!({"connected":false}),
        })
    }
    pub async fn begin(&self, owner: String, redirect: String) -> Result<String> {
        let _gate = self.gate.lock().await;
        let url = url::Url::parse(&redirect).map_err(|_| Error::Validation)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/auth/callback"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Validation);
        }
        let saved = self.saved().await?;
        let registered = self
            .store
            .blocking(|store| {
                Ok(store
                    .open()?
                    .query_row(
                        "SELECT client_id,subject FROM chatgpt_registration WHERE id=1",
                        [],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .optional()?)
            })
            .await?;
        let client_id = saved
            .as_ref()
            .map(|c| c.client_id.clone())
            .or_else(|| registered.as_ref().map(|r| r.0.clone()));
        let subject = saved
            .as_ref()
            .map(|c| c.subject.clone())
            .or_else(|| registered.as_ref().map(|r| r.1.clone()));
        let host = self
            .store
            .blocking(|store| {
                let db = store.open()?;
                db.execute(
                    "INSERT OR IGNORE INTO host_identity VALUES(1,?)",
                    [format!("urn:uuid:{}", uuid::Uuid::new_v4())],
                )?;
                Ok(
                    db.query_row("SELECT host_id FROM host_identity WHERE id=1", [], |r| {
                        r.get::<_, String>(0)
                    })?,
                )
            })
            .await?;
        let state = token();
        let nonce = token();
        let verifier = token();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = url::Url::parse(AUTHORIZE).map_err(|_| Error::Authentication)?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair(
                "client_id",
                client_id.as_deref().unwrap_or("dynamic_agent_client"),
            );
            q.append_pair("ext_agent_host_id", &host)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", &redirect)
                .append_pair(
                    "scope",
                    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                )
                .append_pair("resource", RESOURCE)
                .append_pair("state", &state)
                .append_pair("nonce", &nonce)
                .append_pair("code_challenge_method", "S256")
                .append_pair("code_challenge", &challenge);
            if client_id.is_none() {
                q.append_pair("agent_name_hint", "LittleSpaces");
            }
        }
        *self.pending.lock().await = Some(Attempt {
            state,
            nonce,
            verifier,
            redirect,
            owner,
            expires: now() + 600,
            client_id,
            subject,
        });
        Ok(url.into())
    }
    pub async fn callback(
        &self,
        owner: &str,
        query: std::collections::BTreeMap<String, String>,
    ) -> Result<()> {
        let _gate = self.gate.lock().await;
        let attempt = {
            let mut pending = self.pending.lock().await;
            let p = pending.as_ref().ok_or(Error::Authentication)?;
            use subtle::ConstantTimeEq;
            if p.expires < now()
                || p.owner != owner
                || !bool::from(
                    p.state
                        .as_bytes()
                        .ct_eq(query.get("state").ok_or(Error::Authentication)?.as_bytes()),
                )
            {
                return Err(Error::Authentication);
            }
            pending.take().ok_or(Error::Authentication)?
        };
        if query.contains_key("error") {
            return Err(Error::Authentication);
        }
        let client_id = match (&attempt.client_id, query.get("client_id")) {
            (Some(saved), Some(received)) if saved != received => {
                return Err(Error::Authentication)
            }
            (Some(saved), _) => saved.clone(),
            (None, Some(issued)) if issued.starts_with("oaiapp_") => issued.clone(),
            _ => return Err(Error::Authentication),
        };
        let code = query
            .get("code")
            .filter(|c| c.len() < 8192)
            .ok_or(Error::Authentication)?;
        let response = self
            .client
            .post(TOKEN)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("code", code),
                ("code_verifier", attempt.verifier.as_str()),
                ("redirect_uri", attempt.redirect.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| Error::Authentication)?;
        let tokens: Tokens = self.bounded_json(response).await?;
        validate_tokens(&tokens)?;
        let keys: JwkSet = self
            .bounded_json(
                self.client
                    .get(JWKS)
                    .send()
                    .await
                    .map_err(|_| Error::Authentication)?,
            )
            .await?;
        let identity = validate_identity(&tokens.id_token, &client_id, &attempt.nonce, &keys)?;
        if attempt.subject.as_ref().is_some_and(|s| s != &identity.sub) {
            return Err(Error::Authentication);
        }
        self.save(Credentials {
            subject: identity.sub,
            email: identity.email,
            client_id,
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.clone(),
            id_token: tokens.id_token.clone(),
            expires_at: now() + tokens.expires_in,
            scope: tokens.scope.clone(),
        })
        .await
    }
    async fn bounded_json<T: serde::de::DeserializeOwned>(
        &self,
        mut response: reqwest::Response,
    ) -> Result<T> {
        if !response.status().is_success() {
            return Err(Error::Authentication);
        }
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Authentication)? {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err(Error::Limit);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::Authentication)
    }
    pub(crate) async fn access_token(&self) -> Result<Zeroizing<String>> {
        let _gate = self.gate.lock().await;
        let mut c = self.saved().await?.ok_or(Error::Authentication)?;
        if !c
            .scope
            .split_whitespace()
            .any(|s| s == "chatgpt.tokens.use.direct")
        {
            return Err(Error::Authentication);
        }
        if c.expires_at <= now() + 60 {
            if c.refresh_token.is_empty() {
                return Err(Error::Authentication);
            }
            let response = self
                .client
                .post(TOKEN)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", c.client_id.as_str()),
                    ("refresh_token", c.refresh_token.as_str()),
                    ("resource", RESOURCE),
                ])
                .send()
                .await
                .map_err(|_| Error::Authentication)?;
            let t: Tokens = self.bounded_json(response).await?;
            validate_tokens(&t)?;
            c.access_token = t.access_token.clone();
            if !t.refresh_token.is_empty() {
                c.refresh_token = t.refresh_token.clone();
            }
            // Refresh does not establish a new identity; preserve the last validated ID token.
            if !t.scope.is_empty() {
                c.scope = t.scope.clone();
            }
            c.expires_at = now() + t.expires_in;
            self.save(c.clone()).await?;
        }
        if !c
            .scope
            .split_whitespace()
            .any(|s| s == "chatgpt.tokens.use.direct")
        {
            return Err(Error::Authentication);
        }
        Ok(Zeroizing::new(c.access_token.clone()))
    }
    pub async fn models(&self) -> Result<Value> {
        let token = self.access_token().await?;
        let value: Value = self
            .bounded_json(
                self.client
                    .get("https://api.openai.com/v1/models")
                    .bearer_auth(token.as_str())
                    .send()
                    .await
                    .map_err(|_| Error::Network)?,
            )
            .await?;
        let models = value["models"].as_array().ok_or(Error::Model)?;
        Ok(json!(models
            .iter()
            .filter(|m| m["visibility"] == "list")
            .filter_map(|m| Some(
                json!({"slug":m["slug"].as_str()?,"display_name":m["display_name"].as_str()?})
            ))
            .collect::<Vec<_>>()))
    }
    pub async fn disconnect(&self) -> Result<bool> {
        let _gate = self.gate.lock().await;
        let mut confirmed = true;
        if let Some(c) = self.saved().await? {
            let result = async {
                let response = self
                    .client
                    .get("https://auth.openai.com/.well-known/openid-configuration")
                    .send()
                    .await
                    .map_err(|_| Error::Network)?;
                let document: Value = self.bounded_json(response).await?;
                let endpoint = document["revocation_endpoint"]
                    .as_str()
                    .ok_or(Error::Authentication)?;
                let url = url::Url::parse(endpoint).map_err(|_| Error::Authentication)?;
                if url.scheme() != "https"
                    || url.host_str() != Some("auth.openai.com")
                    || url.port_or_known_default() != Some(443)
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err(Error::Authentication);
                }
                self.client
                    .post(url)
                    .form(&[
                        ("client_id", c.client_id.as_str()),
                        ("token", c.refresh_token.as_str()),
                        ("token_type_hint", "refresh_token"),
                    ])
                    .send()
                    .await
                    .map_err(|_| Error::Network)
            }
            .await;
            confirmed = result.is_ok_and(|r| r.status().is_success());
        }
        *self.pending.lock().await = None;
        self.store
            .blocking(|store| {
                store.open()?.execute("DELETE FROM chatgpt_auth", [])?;
                Ok(())
            })
            .await?;
        Ok(confirmed)
    }
}
fn validate_tokens(t: &Tokens) -> Result<()> {
    if !t.token_type.eq_ignore_ascii_case("bearer")
        || t.access_token.is_empty()
        || t.access_token.len() > 32768
        || t.expires_in <= 0
        || t.expires_in > 86400 * 7
    {
        return Err(Error::Authentication);
    }
    Ok(())
}
fn validate_identity(token: &str, client_id: &str, nonce: &str, keys: &JwkSet) -> Result<Identity> {
    let header = decode_header(token).map_err(|_| Error::Authentication)?;
    if header.alg != Algorithm::RS256 {
        return Err(Error::Authentication);
    }
    let key = keys
        .find(header.kid.as_deref().ok_or(Error::Authentication)?)
        .ok_or(Error::Authentication)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    validation.leeway = 5;
    validation.validate_nbf = true;
    let claims = decode::<Identity>(
        token,
        &DecodingKey::from_jwk(key).map_err(|_| Error::Authentication)?,
        &validation,
    )
    .map_err(|_| Error::Authentication)?
    .claims;
    if claims.sub.is_empty() || claims.nonce != nonce || claims.iat > now() + 5 {
        return Err(Error::Authentication);
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_signed_identity_nonce_audience_issuer_and_expiry() {
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(include_bytes!(
            "../../tests/fixtures/oidc-test-only.pem"
        ))
        .unwrap();
        let keys: JwkSet = serde_json::from_str(include_str!(
            "../../tests/fixtures/oidc-test-only-jwks.json"
        ))
        .unwrap();
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        let claims = json!({"sub":"synthetic-owner","iss":ISSUER,"aud":"oaiapp_test","iat":now(),"exp":now()+600,"nonce":"test-nonce"});
        let jwt = jsonwebtoken::encode(&header, &claims, &key).unwrap();
        assert_eq!(
            validate_identity(&jwt, "oaiapp_test", "test-nonce", &keys)
                .unwrap()
                .sub,
            "synthetic-owner"
        );
        for (client, nonce) in [
            ("wrong-client", "test-nonce"),
            ("oaiapp_test", "wrong-nonce"),
        ] {
            assert!(validate_identity(&jwt, client, nonce, &keys).is_err());
        }
        let mut expired = claims.clone();
        expired["exp"] = json!(now() - 60);
        let jwt = jsonwebtoken::encode(&header, &expired, &key).unwrap();
        assert!(validate_identity(&jwt, "oaiapp_test", "test-nonce", &keys).is_err());
        let mut wrong = claims;
        wrong["iss"] = json!("https://example.com");
        let jwt = jsonwebtoken::encode(&header, &wrong, &key).unwrap();
        assert!(validate_identity(&jwt, "oaiapp_test", "test-nonce", &keys).is_err());
    }
    #[tokio::test]
    async fn oauth_state_is_bound_and_tokens_are_separate_encrypted_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets = Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
        let auth = ChatGpt::new(store.clone(), secrets.clone()).unwrap();
        let url = auth
            .begin(
                "owner-session".into(),
                "http://127.0.0.1:54321/auth/callback".into(),
            )
            .await
            .unwrap();
        let url = url::Url::parse(&url).unwrap();
        let q = url
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(q["client_id"], "dynamic_agent_client");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["agent_name_hint"], "LittleSpaces");
        assert!(q["ext_agent_host_id"].starts_with("urn:uuid:"));
        assert_eq!(
            auth.callback(
                "other-owner",
                std::collections::BTreeMap::from([("state".into(), q["state"].to_string())])
            )
            .await,
            Err(Error::Authentication)
        );
        let c = Credentials {
            subject: "synthetic".into(),
            email: None,
            client_id: "oaiapp_test".into(),
            access_token: "not-a-real-access-token".into(),
            refresh_token: "not-a-real-refresh-token".into(),
            id_token: "not-a-real-id-token".into(),
            expires_at: now() + 1000,
            scope: "chatgpt.tokens.use.direct".into(),
        };
        auth.save(c).await.unwrap();
        assert!(secrets.list().unwrap().is_empty());
        assert_eq!(
            auth.access_token().await.unwrap().as_str(),
            "not-a-real-access-token"
        );
        let bytes = std::fs::read(dir.path().join("db.sqlite")).unwrap();
        assert!(!bytes
            .windows(b"not-a-real-access-token".len())
            .any(|w| w == b"not-a-real-access-token"));
    }
}

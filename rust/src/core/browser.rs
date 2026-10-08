//! Optional development browser harness. It is not part of the application runtime.
use super::{owner::now, store::Records, *};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
#[derive(Clone)]
pub struct BrowserConfig {
    pub origin: String,
    pub endpoint: String,
    pub token: Arc<zeroize::Zeroizing<String>>,
}
impl BrowserConfig {
    pub fn from_environment(origin: String) -> Result<Option<Self>> {
        let Ok(endpoint) = std::env::var("LITTLESPACES_BROWSER_HARNESS") else {
            return Ok(None);
        };
        let url = url::Url::parse(&endpoint).map_err(|_| Error::Validation)?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
            return Err(Error::Validation);
        }
        let token = std::env::var("LITTLESPACES_BROWSER_TOKEN").map_err(|_| Error::Validation)?;
        if token.len() < 32 {
            return Err(Error::Validation);
        }
        Ok(Some(Self {
            origin,
            endpoint,
            token: Arc::new(zeroize::Zeroizing::new(token)),
        }))
    }
}
#[derive(Clone)]
pub(crate) struct Preview {
    pub app: AppId,
    pub revision: RevisionId,
    pub records: Arc<tokio::sync::Mutex<Records>>,
    pub http: super::http::MockHttp,
    expires: i64,
}
#[derive(Clone, Default)]
pub(crate) struct Previews(Arc<tokio::sync::Mutex<BTreeMap<String, Preview>>>);
impl Previews {
    pub async fn create(
        &self,
        app: AppId,
        revision: RevisionId,
        http: super::http::MockHttp,
    ) -> Result<String> {
        let mut sessions = self.0.lock().await;
        sessions.retain(|_, p| p.expires > now());
        if sessions.len() >= 4 {
            return Err(Error::Saturated);
        }
        let ticket = super::owner::token();
        sessions.insert(
            ticket.clone(),
            Preview {
                app,
                revision,
                records: Arc::new(tokio::sync::Mutex::new(Records::new())),
                http,
                expires: now() + 120,
            },
        );
        Ok(ticket)
    }
    pub async fn get(&self, ticket: &str) -> Result<Preview> {
        self.0
            .lock()
            .await
            .get(ticket)
            .filter(|p| p.expires > now())
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub async fn remove(&self, ticket: &str) {
        self.0.lock().await.remove(ticket);
    }
}
pub async fn test(
    runtime: &Runtime,
    app: AppId,
    id: RevisionId,
    cancel: Cancellation,
) -> Result<Value> {
    let config = runtime.browser.as_ref().ok_or(Error::BrowserUnavailable)?;
    let a = app.clone();
    let r = id.clone();
    let revision = runtime.store.blocking(move |s| s.revision(&a, &r)).await?;
    if revision.code.frontend.is_empty() || revision.code.frontend_tests.is_empty() {
        return Err(Error::Untested);
    }
    let ticket = runtime
        .previews
        .create(
            app.clone(),
            id.clone(),
            super::http::MockHttp(
                revision
                    .code
                    .tests
                    .iter()
                    .flat_map(|t| t.http.clone())
                    .collect(),
            ),
        )
        .await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| Error::Network)?;
    let result = async {
        let response=client.post(&config.endpoint).bearer_auth(config.token.as_str()).json(&json!({"url":format!("{}/preview-test/{ticket}",config.origin),"steps":revision.code.frontend_tests})).send().await.map_err(|_|Error::BrowserUnavailable)?;
        if !response.status().is_success() {
            return Err(Error::BrowserUnavailable);
        }
        let mut bytes = Vec::new();
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Network)? {
            if bytes.len() + chunk.len() > 128 * 1024 {
                return Err(Error::Limit);
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut report: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Validation)?;
        report
            .as_object_mut()
            .ok_or(Error::Validation)?
            .insert("kind".into(), json!("browser_harness"));
        if report["passed"] == true && report["assertions"].as_u64().is_some_and(|n| n > 0) {
            let digest = revision.digest.clone();
            let stored = report.clone();
            let id = id.clone();
            runtime
                .store
                .blocking(move |store| {
                    store.open()?.execute(
                        "INSERT OR REPLACE INTO frontend_checks VALUES(?,?,?)",
                        rusqlite::params![id.0, digest, stored.to_string()],
                    )?;
                    Ok(())
                })
                .await?;
        }
        Ok(report)
    };
    let result = tokio::select! {r=result=>r,_=async{while !cancel.is_cancelled(){tokio::time::sleep(Duration::from_millis(20)).await;}}=>Err(Error::Cancelled)};
    runtime.previews.remove(&ticket).await;
    result
}

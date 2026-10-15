//! Durable inbox and encrypted Web Push. Script notifications commit with app records.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::{elliptic_curve::sec1::ToEncodedPoint, pkcs8::EncodePrivateKey};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubscriptionInfo {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}
impl SubscriptionInfo {
    #[cfg(test)]
    fn new(
        endpoint: impl Into<String>,
        p256dh: impl Into<String>,
        auth: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            keys: SubscriptionKeys {
                p256dh: p256dh.into(),
                auth: auth.into(),
            },
        }
    }
}
struct PushMessage {
    content: Vec<u8>,
    authorization: String,
}
fn vapid_key(encoded: &str) -> Result<p256::SecretKey> {
    let bytes = zeroize::Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| Error::Storage)?,
    );
    p256::SecretKey::from_slice(&bytes).map_err(|_| Error::Storage)
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notice {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub due_at: Option<String>,
}
impl Notice {
    pub fn due(&self) -> Result<i64> {
        if self.key.is_empty()
            || self.key.len() > 160
            || self.title.trim().is_empty()
            || self.title.len() > 120
            || self.body.len() > 2000
        {
            return Err(Error::Validation);
        }
        self.due_at
            .as_ref()
            .map(|s| {
                chrono::DateTime::parse_from_rfc3339(s)
                    .map(|d| d.timestamp_millis())
                    .map_err(|_| Error::Validation)
            })
            .unwrap_or(Ok(now()))
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub enum Change {
    Put(Notice),
    Remove(String),
}
pub fn apply(tx: &rusqlite::Transaction<'_>, app: &AppId, changes: &[Change]) -> Result<()> {
    for change in changes {
        match change {
            Change::Put(n) => {
                let mut due = n.due()?;
                if n.due_at.is_none() {
                    if let Some(previous) = tx.query_row("SELECT due_at FROM notifications WHERE app=? AND key=? AND title=? AND body=? AND due_at<=?",params![app.0,n.key,n.title,n.body,now()],|r|r.get::<_,i64>(0)).optional()? { due=previous; }
                }
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM notifications WHERE app=? AND key<>?",
                    params![app.0, n.key],
                    |r| r.get(0),
                )?;
                if count >= 500 {
                    return Err(Error::Limit);
                }
                tx.execute("INSERT INTO notifications(id,app,key,title,body,href,due_at,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(app,key) DO UPDATE SET title=excluded.title,body=excluded.body,due_at=excluded.due_at,created_at=excluded.created_at,is_read=0,version=notifications.version+1 WHERE notifications.title<>excluded.title OR notifications.body<>excluded.body OR notifications.due_at<>excluded.due_at",params![owner::token(),app.0,n.key,n.title,n.body,format!("/apps/{}",app.0),due,now()])?;
            }
            Change::Remove(key) => {
                tx.execute(
                    "DELETE FROM notifications WHERE app=? AND key=?",
                    params![app.0, key],
                )?;
            }
        }
    }
    Ok(())
}
pub fn list(store: &Store) -> Result<Value> {
    let db = store.open()?;
    let mut q=db.prepare("SELECT id,title,body,href,is_read,due_at FROM notifications WHERE NOT EXISTS(SELECT 1 FROM archived_apps a WHERE a.app=notifications.app) AND due_at<=? ORDER BY due_at DESC LIMIT 500")?;
    let rows=q.query_map([now()],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"body":r.get::<_,String>(2)?,"href":r.get::<_,String>(3)?,"read":r.get::<_,bool>(4)?,"dueAt":r.get::<_,i64>(5)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
pub fn read(store: &Store, id: Option<&str>) -> Result<()> {
    store.open()?.execute(
        "UPDATE notifications SET is_read=1 WHERE due_at<=? AND (? IS NULL OR id=?)",
        params![now(), id, id],
    )?;
    Ok(())
}
pub fn validate_subscription(sub: &SubscriptionInfo) -> Result<()> {
    let url = url::Url::parse(&sub.endpoint).map_err(|_| Error::Validation)?;
    if sub.endpoint.len() > 4096
        || url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !matches!(
            url.host_str(),
            Some(
                "fcm.googleapis.com"
                    | "updates.push.services.mozilla.com"
                    | "updates-autopush.stage.mozaws.net"
                    | "web.push.apple.com"
            )
        )
    {
        return Err(Error::Validation);
    }
    let key = URL_SAFE_NO_PAD
        .decode(sub.keys.p256dh.trim_end_matches('='))
        .map_err(|_| Error::Validation)?;
    let auth = URL_SAFE_NO_PAD
        .decode(sub.keys.auth.trim_end_matches('='))
        .map_err(|_| Error::Validation)?;
    if auth.len() != 16
        || key.len() != 65
        || key.first() != Some(&4)
        || p256::PublicKey::from_sec1_bytes(&key).is_err()
    {
        return Err(Error::Validation);
    }
    Ok(())
}
fn private_key(store: &Store, secrets: &secrets::Secrets) -> Result<String> {
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: Option<Vec<u8>> = tx
        .query_row("SELECT ciphertext FROM push_identity WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    let raw = if let Some(cipher) = existing {
        secrets.unseal("push-vapid", &cipher)?.to_vec()
    } else {
        let bytes = p256::SecretKey::random(&mut rand::thread_rng())
            .to_bytes()
            .to_vec();
        tx.execute(
            "INSERT INTO push_identity VALUES(1,?)",
            [secrets.seal("push-vapid", &bytes)?],
        )?;
        bytes
    };
    tx.commit()?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}
pub fn public_key(store: &Store, secrets: &secrets::Secrets) -> Result<String> {
    let key = private_key(store, secrets)?;
    Ok(URL_SAFE_NO_PAD.encode(
        vapid_key(&key)?
            .public_key()
            .to_encoded_point(false)
            .as_bytes(),
    ))
}
pub fn subscribe(store: &Store, secrets: &secrets::Secrets, sub: SubscriptionInfo) -> Result<()> {
    validate_subscription(&sub)?;
    let cipher = secrets.seal(
        "push-subscription",
        &serde_json::to_vec(&sub).map_err(|_| Error::Validation)?,
    )?;
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM push_subscriptions WHERE endpoint<>?",
        [&sub.endpoint],
        |r| r.get(0),
    )?;
    if count >= 20 {
        return Err(Error::Limit);
    }
    tx.execute("INSERT INTO push_subscriptions VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET ciphertext=excluded.ciphertext",params![sub.endpoint,cipher,now()])?;
    tx.commit()?;
    Ok(())
}
pub fn unsubscribe(store: &Store, endpoint: &str) -> Result<()> {
    store.open()?.execute(
        "DELETE FROM push_subscriptions WHERE endpoint=?",
        [endpoint],
    )?;
    Ok(())
}
pub fn test_notice(store: &Store) -> Result<()> {
    store.open()?.execute("INSERT INTO notifications(id,key,title,body,href,due_at,created_at) VALUES(?,?,'Notifications are working','LittleSpaces can send updates to this device.','/',?,?)",params![owner::token(),owner::token(),now(),now()])?;
    Ok(())
}
fn completed_jobs(store: &Store) -> Result<()> {
    // A startup watermark avoids re-notifying years of existing job history.
    let db = store.open()?;
    db.execute("INSERT INTO notifications(id,key,title,body,href,due_at,created_at,is_read) SELECT 'job:'||j.id,'job:'||j.id,CASE j.state WHEN 'completed' THEN 'Reply ready' ELSE 'Reply needs attention' END,c.title,'/chat/'||c.id,?, ?,0 FROM jobs j JOIN conversations c ON c.id=j.conversation WHERE j.state IN ('completed','failed','interrupted') AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.id='job:'||j.id) AND j.rowid>(SELECT COALESCE(MAX(rowid),0) FROM jobs WHERE id=(SELECT key FROM notifications WHERE id='push-job-watermark'))",params![now()+5000,now()])?;
    Ok(())
}
pub fn acknowledge_job(store: &Store, job: &str) -> Result<()> {
    completed_jobs(store)?;
    store.open()?.execute(
        "UPDATE notifications SET is_read=1 WHERE id=?",
        [format!("job:{job}")],
    )?;
    Ok(())
}
pub fn initialize_jobs(store: &Store) -> Result<()> {
    store.open()?.execute("INSERT OR IGNORE INTO notifications(id,key,title,body,href,due_at,created_at,is_read) VALUES('push-job-watermark',COALESCE((SELECT id FROM jobs ORDER BY rowid DESC LIMIT 1),''),'','','/',9223372036854775807,0,1)",[])?;
    Ok(())
}
fn encrypt_message(key: &str, sub: &SubscriptionInfo, payload: &[u8]) -> Result<PushMessage> {
    validate_subscription(sub)?;
    // RFC 8292 ES256 VAPID plus RFC 8291 aes128gcm. Both cryptographic
    // operations use existing libraries; no unused RSA signing dependency.
    let key = vapid_key(key)?;
    let public = URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes());
    let private = key.to_pkcs8_der().map_err(|_| Error::Storage)?;
    let audience = url::Url::parse(&sub.endpoint)
        .map_err(|_| Error::Validation)?
        .origin()
        .ascii_serialization();
    let claims = json!({"aud":audience,"exp":owner::now()+12*3600,
        "sub":std::env::var("VAPID_SUBJECT").unwrap_or_else(|_|"mailto:owner@example.com".into())});
    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
        &claims,
        &jsonwebtoken::EncodingKey::from_ec_der(private.as_bytes()),
    )
    .map_err(|_| Error::Storage)?;
    let recipient = URL_SAFE_NO_PAD
        .decode(sub.keys.p256dh.trim_end_matches('='))
        .map_err(|_| Error::Validation)?;
    let auth = URL_SAFE_NO_PAD
        .decode(sub.keys.auth.trim_end_matches('='))
        .map_err(|_| Error::Validation)?;
    let content = ece::encrypt(&recipient, &auth, payload).map_err(|_| Error::Storage)?;
    Ok(PushMessage {
        content,
        authorization: format!("vapid t={jwt}, k={public}"),
    })
}

fn reserve_attempt(store: &Store, endpoint: &str, id: &str, version: i64) -> Result<()> {
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let previous: i64 = tx
        .query_row(
            "SELECT attempts FROM push_attempts WHERE endpoint=? AND notification=? AND version=?",
            params![endpoint, id, version],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let attempts = previous + 1;
    let delay = (30_i64 * 2_i64.pow(previous.min(10) as u32)).min(21600);
    tx.execute("INSERT INTO push_attempts VALUES(?,?,?,?,?,NULL,0) ON CONFLICT(endpoint,notification) DO UPDATE SET version=excluded.version,attempts=excluded.attempts,next_attempt=excluded.next_attempt,last_status=NULL,terminal=0",params![endpoint,id,version,attempts,now()+delay*1000])?;
    tx.commit()?;
    Ok(())
}
fn finish_attempt(
    store: &Store,
    endpoint: &str,
    id: &str,
    version: i64,
    status: Option<u16>,
    retry_after: Option<i64>,
) -> Result<()> {
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if matches!(status, Some(404 | 410)) {
        tx.execute(
            "DELETE FROM push_subscriptions WHERE endpoint=?",
            [endpoint],
        )?;
    } else if status.is_some_and(|s| (200..300).contains(&s)) {
        tx.execute("INSERT INTO push_deliveries SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint=?) AND EXISTS(SELECT 1 FROM notifications WHERE id=?) ON CONFLICT(endpoint,notification) DO UPDATE SET version=excluded.version",params![endpoint,id,version,endpoint,id])?;
        tx.execute(
            "DELETE FROM push_attempts WHERE endpoint=? AND notification=? AND version=?",
            params![endpoint, id, version],
        )?;
    } else {
        let permanent = status.is_some_and(|s| (400..500).contains(&s) && ![408, 429].contains(&s));
        tx.execute("UPDATE push_attempts SET last_status=?,terminal=(? OR attempts>=8),next_attempt=MAX(next_attempt,?) WHERE endpoint=? AND notification=? AND version=?",params![status,permanent,now()+retry_after.unwrap_or(0).clamp(0,86400)*1000,endpoint,id,version])?;
    }
    tx.commit()?;
    Ok(())
}
pub fn delivery_status(store: &Store) -> Result<Value> {
    Ok(store.open()?.query_row("SELECT COUNT(*),COALESCE(SUM(terminal),0) FROM push_attempts",[],|r|Ok(json!({"retrying":r.get::<_,i64>(0)?-r.get::<_,i64>(1)?,"failed":r.get::<_,i64>(1)?})))?)
}
pub(crate) async fn run(
    store: Store,
    secrets: secrets::Secrets,
    operations: super::operations::Operations,
) {
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return;
    };
    while !operations.stopping() {
        let s = secrets.clone();
        let batch=store.blocking(move |store| {
            completed_jobs(&store)?;
            let db=store.open()?;
            let mut q=db.prepare("SELECT s.endpoint,s.ciphertext,n.id,n.version,n.title,n.body,n.href FROM push_subscriptions s JOIN notifications n ON n.created_at>=s.created_at WHERE n.is_read=0 AND NOT EXISTS(SELECT 1 FROM archived_apps a WHERE a.app=n.app) AND n.due_at<=? AND NOT EXISTS(SELECT 1 FROM push_attempts a WHERE a.endpoint=s.endpoint AND a.notification=n.id AND a.version=n.version AND (a.terminal=1 OR a.next_attempt>?)) AND NOT EXISTS(SELECT 1 FROM push_deliveries d WHERE d.endpoint=s.endpoint AND d.notification=n.id AND d.version=n.version) ORDER BY n.due_at LIMIT 20")?;
            let rows=q.query_map([now(),now()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            let key=private_key(&store,&s)?;
            let mut result=Vec::new();
            for (endpoint,cipher,id,version,title,body,href) in rows {
                let sub:SubscriptionInfo=serde_json::from_slice(&s.unseal("push-subscription",&cipher)?).map_err(|_|Error::Storage)?;
                validate_subscription(&sub)?;
                let payload=json!({"id":id,"title":title,"body":body.chars().take(500).collect::<String>(),"href":href}).to_string();
                result.push((endpoint,id,version,encrypt_message(&key,&sub,payload.as_bytes())?));
            }
            Ok(result)
        }).await;
        operations.push(batch.is_ok());
        if let Err(error) = &batch {
            super::telemetry::error("push.batch", *error);
        }
        if let Ok(batch) = batch {
            for (endpoint, id, version, message) in batch {
                if operations.stopping() {
                    break;
                }
                operations.push(true);
                let e = endpoint.clone();
                let i = id.clone();
                let pending=store.blocking(move |store|Ok(store.open()?.query_row("SELECT EXISTS(SELECT 1 FROM push_subscriptions s, notifications n WHERE s.endpoint=? AND n.id=? AND n.version=? AND n.is_read=0 AND NOT EXISTS(SELECT 1 FROM archived_apps a WHERE a.app=n.app) AND n.due_at<=?)",params![e,i,version,now()],|r|r.get::<_,bool>(0))?)).await;
                if pending != Ok(true) {
                    continue;
                }
                let e = endpoint.clone();
                let i = id.clone();
                if let Err(error) = store
                    .blocking(move |store| reserve_attempt(&store, &e, &i, version))
                    .await
                {
                    super::telemetry::error("push.reserve", error);
                    continue;
                }
                let request = client
                    .post(&endpoint)
                    .header("TTL", 86400)
                    .header("Content-Type", "application/octet-stream")
                    .header("Content-Encoding", "aes128gcm")
                    .header("Authorization", message.authorization)
                    .body(message.content);
                let response = request.send().await;
                let status = response.as_ref().ok().map(|r| r.status().as_u16());
                let retry_after = response
                    .as_ref()
                    .ok()
                    .and_then(|r| r.headers().get("retry-after"))
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<i64>().ok());
                if let Err(error) = store
                    .blocking(move |store| {
                        finish_attempt(&store, &endpoint, &id, version, status, retry_after)
                    })
                    .await
                {
                    super::telemetry::error("push.finish", error);
                }
            }
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_secs(15))=>{}, _=operations.stopped()=>{} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewed_reply_is_read_before_push_but_other_replies_remain_pending() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
        initialize_jobs(&store).unwrap();
        let db = store.open().unwrap();
        db.execute(
            "INSERT INTO conversations(id,title) VALUES('visible','Visible'),('away','Away')",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO jobs(id,conversation,state,payload) VALUES('seen','visible','completed','{}'),('unseen','away','completed','{}')", []).unwrap();
        acknowledge_job(&store, "seen").unwrap();
        completed_jobs(&store).unwrap();
        let read: bool = db
            .query_row(
                "SELECT is_read FROM notifications WHERE id='job:seen'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(read);
        let (unread, due): (bool, i64) = db
            .query_row(
                "SELECT is_read=0,due_at FROM notifications WHERE id='job:unseen'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(unread);
        assert!(due > now());
        // Acknowledging before completion must not silence the later reply.
        db.execute("INSERT INTO jobs(id,conversation,state,payload) VALUES('later','visible','running','{}')", []).unwrap();
        acknowledge_job(&store, "later").unwrap();
        db.execute("UPDATE jobs SET state='completed' WHERE id='later'", [])
            .unwrap();
        completed_jobs(&store).unwrap();
        assert!(!db
            .query_row(
                "SELECT is_read FROM notifications WHERE id='job:later'",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }
    #[test]
    fn push_payload_is_signed_and_decryptable_by_only_its_recipient() {
        let (recipient, auth) = ece::generate_keypair_and_auth_secret().unwrap();
        let sub = SubscriptionInfo::new(
            "https://fcm.googleapis.com/test".to_owned(),
            URL_SAFE_NO_PAD.encode(recipient.pub_as_raw().unwrap()),
            URL_SAFE_NO_PAD.encode(auth),
        );
        validate_subscription(&sub).unwrap();
        let private =
            URL_SAFE_NO_PAD.encode(p256::SecretKey::random(&mut rand::thread_rng()).to_bytes());
        let plain = br#"{"title":"Ready","body":"Saved","href":"/chat/example"}"#;
        let message = encrypt_message(&private, &sub, plain).unwrap();
        let token = message
            .authorization
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let public = vapid_key(&private)
            .unwrap()
            .public_key()
            .to_encoded_point(false);
        let decoding = jsonwebtoken::DecodingKey::from_ec_components(
            &URL_SAFE_NO_PAD.encode(public.x().unwrap()),
            &URL_SAFE_NO_PAD.encode(public.y().unwrap()),
        )
        .unwrap();
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::ES256);
        validation.set_audience(&["https://fcm.googleapis.com"]);
        let claims = jsonwebtoken::decode::<Value>(token, &decoding, &validation)
            .unwrap()
            .claims;
        assert!(claims["exp"].as_i64().unwrap() > owner::now());
        assert!(claims["exp"].as_i64().unwrap() <= owner::now() + 24 * 3600);
        assert!(message
            .authorization
            .ends_with(&URL_SAFE_NO_PAD.encode(public.as_bytes())));
        let decoded = ece::decrypt(
            &recipient.raw_components().unwrap(),
            &auth,
            &message.content,
        )
        .unwrap();
        assert_eq!(decoded, plain);
        let (other, other_auth) = ece::generate_keypair_and_auth_secret().unwrap();
        assert!(ece::decrypt(
            &other.raw_components().unwrap(),
            &other_auth,
            &message.content
        )
        .is_err());
    }
    #[test]
    fn inbox_dedup_due_and_encrypted_subscription_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
        let secrets = secrets::Secrets::open(store.clone(), &dir.path().join("key")).unwrap();
        let app = store.create_app("Reminders").unwrap();
        let key = public_key(&store, &secrets).unwrap();
        assert_eq!(key, public_key(&store, &secrets).unwrap());
        assert!(secrets.list().unwrap().is_empty());
        let valid = SubscriptionInfo::new(
            "https://fcm.googleapis.com/test",
            &key,
            URL_SAFE_NO_PAD.encode([1u8; 16]),
        );
        subscribe(&store, &secrets, valid).unwrap();
        let db = store.open().unwrap();
        let cipher: Vec<u8> = db
            .query_row("SELECT ciphertext FROM push_subscriptions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&cipher).contains(&key));
        for endpoint in [
            "https://127.0.0.1/push",
            "https://fcm.googleapis.com.evil.test/push",
            "http://fcm.googleapis.com/push",
            "https://fcm.googleapis.com:444/push",
        ] {
            assert!(validate_subscription(&SubscriptionInfo::new(
                endpoint,
                &key,
                URL_SAFE_NO_PAD.encode([1u8; 16])
            ))
            .is_err());
        }
        let notice = Notice {
            key: "reminder".into(),
            title: "Ready".into(),
            body: "Check task".into(),
            due_at: None,
        };
        let mut db = store.open().unwrap();
        for _ in 0..2 {
            let tx = db.transaction().unwrap();
            apply(&tx, &app, &[Change::Put(notice.clone())]).unwrap();
            tx.commit().unwrap();
            read(&store, None).unwrap();
        }
        let rows = list(&store).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["read"], true);
        let tx = db.transaction().unwrap();
        apply(&tx, &app, &[Change::Remove("reminder".into())]).unwrap();
        tx.commit().unwrap();
        assert_eq!(list(&store).unwrap(), json!([]));
        unsubscribe(&store, "https://fcm.googleapis.com/test").unwrap();
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    #[test]
    fn failures_back_off_and_new_versions_reset_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db")).unwrap();
        let db = store.open().unwrap();
        db.execute("INSERT INTO push_subscriptions VALUES('test',x'00',0)", [])
            .unwrap();
        db.execute("INSERT INTO notifications(id,key,title,body,href,due_at,created_at) VALUES('n','n','T','','/',0,0)",[]).unwrap();
        reserve_attempt(&store, "test", "n", 1).unwrap();
        finish_attempt(&store, "test", "n", 1, Some(429), Some(600)).unwrap();
        let next: i64 = db
            .query_row("SELECT next_attempt FROM push_attempts", [], |r| r.get(0))
            .unwrap();
        assert!(next >= now() + 599000);
        for _ in 1..8 {
            reserve_attempt(&store, "test", "n", 1).unwrap();
            finish_attempt(&store, "test", "n", 1, None, None).unwrap();
        }
        assert_eq!(delivery_status(&store).unwrap()["failed"], 1);
        reserve_attempt(&store, "test", "n", 2).unwrap();
        assert_eq!(
            db.query_row("SELECT attempts FROM push_attempts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        finish_attempt(&store, "test", "n", 2, Some(201), None).unwrap();
        assert_eq!(delivery_status(&store).unwrap()["retrying"], 0);
    }
}

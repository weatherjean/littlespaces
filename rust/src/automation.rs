use crate::store::{execute, first, now, query, text, Result, Store, LAUNCHER};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::str::FromStr;

pub fn notifications(store: &Store, space: Option<&str>, future: bool) -> Result<Value> {
    let rows=query(&store.workspace()?,"SELECT n.*,s.name AS source FROM notifications n JOIN spaces s ON s.id=n.space_id WHERE s.archived=0 AND (? IS NULL OR n.space_id=?) AND (? OR n.due_at<=?) ORDER BY n.due_at DESC",&[json!(space),json!(space),json!(future),json!(now())])?;
    Ok(json!(rows.into_iter().map(|row|{let space=text(&row,"space_id");let key=text(&row,"key");let href=if let Some(chat)=key.strip_prefix("chat:"){format!("{}/{chat}",if space==LAUNCHER{"/chat".into()}else{format!("/spaces/{space}/chat")})}else if space==LAUNCHER{"/chat".into()}else{format!("/spaces/{space}/applet")};json!({"id":row["id"],"spaceId":space,"key":key,"title":row["title"],"body":row["body"],"dueAt":row["due_at"],"read":row["is_read"]==json!(1),"source":row["source"],"href":href})}).collect::<Vec<_>>()))
}
pub fn notify(store: &Store, space: &str, input: &Value) -> Result<Value> {
    store.space(space)?;
    for (key, max) in [("key", 160), ("title", 120), ("body", 2000)] {
        if text(input, key).chars().count() > max
            || (key != "body" && text(input, key).trim().is_empty())
        {
            return Err(format!("Provide notification {key}"));
        }
    }
    let due = if text(input, "dueAt").is_empty() {
        now()
    } else {
        DateTime::parse_from_rfc3339(text(input, "dueAt"))
            .map_err(|_| "Invalid reminder time")?
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let db = store.workspace()?;
    let count = first(
        &db,
        "SELECT COUNT(*) AS n FROM notifications WHERE space_id=?",
        &[json!(space)],
    )?["n"]
        .as_i64()
        .unwrap_or(0);
    if count >= 500
        && first(
            &db,
            "SELECT id FROM notifications WHERE space_id=? AND key=?",
            &[json!(space), input["key"].clone()],
        )
        .is_err()
    {
        return Err("Notification limit reached".into());
    }
    execute(&db,"INSERT INTO notifications(id,space_id,key,title,body,due_at) VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,key) DO UPDATE SET title=excluded.title,body=excluded.body,due_at=excluded.due_at,is_read=CASE WHEN notifications.title=excluded.title AND notifications.body=excluded.body AND notifications.due_at=excluded.due_at THEN notifications.is_read ELSE 0 END",&[json!(crate::random_uuid()),json!(space),input["key"].clone(),input["title"].clone(),input["body"].clone(),json!(due)])?;
    notifications(store, Some(space), true)?
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["key"] == input["key"]))
        .cloned()
        .ok_or("Could not read the saved notification".into())
}
pub fn next_cron(expression: &str, timezone: &str, after: DateTime<Utc>) -> Result<String> {
    if expression.split_whitespace().count() != 5 {
        return Err("Use a five-field cron expression".into());
    }
    let zone = chrono_tz::Tz::from_str(timezone).map_err(|_| "Invalid IANA timezone")?;
    let schedule = croner::Cron::from_str(expression).map_err(|e| format!("Invalid cron: {e}"))?;
    let next = schedule
        .find_next_occurrence(&after.with_timezone(&zone), false)
        .map_err(|e| e.to_string())?;
    Ok(next
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
pub fn schedules(store: &Store, space: Option<&str>) -> Result<Value> {
    Ok(json!(query(
        &store.workspace()?,
        "SELECT * FROM schedules WHERE (? IS NULL OR space_id=?) ORDER BY next_run",
        &[json!(space), json!(space)]
    )?))
}
pub fn schedule(store: &Store, space: &str, input: &Value) -> Result<Value> {
    store.space(space)?;
    for (key, max) in [
        ("key", 160),
        ("title", 120),
        ("prompt", 4000),
        ("model", 150),
        ("timezone", 100),
    ] {
        if text(input, key).trim().is_empty() || text(input, key).chars().count() > max {
            return Err(format!("Provide a valid {key}"));
        }
    }
    let cron = text(input, "cron");
    let due = text(input, "dueAt");
    if cron.is_empty() == due.is_empty() {
        return Err("Provide either cron or dueAt".into());
    }
    let next = if !cron.is_empty() {
        next_cron(cron, text(input, "timezone"), Utc::now())?
    } else {
        chrono_tz::Tz::from_str(text(input, "timezone")).map_err(|_| "Invalid timezone")?;
        DateTime::parse_from_rfc3339(due)
            .map_err(|_| "Invalid date")?
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    if next <= now() {
        return Err("Choose a future time".into());
    }
    let db = store.workspace()?;
    if first(&db, "SELECT COUNT(*) AS n FROM schedules", &[])?["n"]
        .as_i64()
        .unwrap_or(0)
        >= 100
        && first(
            &db,
            "SELECT id FROM schedules WHERE space_id=? AND key=?",
            &[json!(space), input["key"].clone()],
        )
        .is_err()
    {
        return Err("Schedule limit reached".into());
    }
    execute(&db,"INSERT INTO schedules(id,space_id,key,title,prompt,cron,timezone,model,next_run) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(space_id,key) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,cron=excluded.cron,timezone=excluded.timezone,model=excluded.model,next_run=excluded.next_run,enabled=1,last_error=NULL,revision=schedules.revision+1",&[json!(crate::random_uuid()),json!(space),input["key"].clone(),input["title"].clone(),input["prompt"].clone(),if cron.is_empty(){Value::Null}else{json!(cron)},input["timezone"].clone(),input["model"].clone(),json!(next)])?;
    first(
        &db,
        "SELECT * FROM schedules WHERE space_id=? AND key=?",
        &[json!(space), input["key"].clone()],
    )
}
pub fn vapid(store: &Store) -> Result<Value> {
    let db = store.workspace()?;
    if let Ok(row) = first(&db, "SELECT value FROM settings WHERE key='vapid'", &[]) {
        return serde_json::from_str(text(&row, "value")).map_err(|e| e.to_string());
    }
    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let public = secret.public_key().to_encoded_point(false);
    let keys = json!({"publicKey":URL_SAFE_NO_PAD.encode(public.as_bytes()),"privateKey":URL_SAFE_NO_PAD.encode(secret.to_bytes())});
    execute(
        &db,
        "INSERT INTO settings VALUES('vapid',?)",
        &[json!(keys.to_string())],
    )?;
    Ok(keys)
}
pub fn subscription(value: &Value) -> Result<()> {
    let url = url::Url::parse(text(value, "endpoint")).map_err(|_| "Invalid push subscription")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || ![
            "fcm.googleapis.com",
            "updates.push.services.mozilla.com",
            "updates-autopush.stage.mozaws.net",
            "web.push.apple.com",
        ]
        .contains(&url.host_str().unwrap_or(""))
    {
        return Err("Unsupported push provider".into());
    }
    if URL_SAFE_NO_PAD
        .decode(text(&value["keys"], "p256dh").trim_end_matches('='))
        .map_err(|_| "Invalid push keys")?
        .len()
        != 65
        || URL_SAFE_NO_PAD
            .decode(text(&value["keys"], "auth").trim_end_matches('='))
            .map_err(|_| "Invalid push keys")?
            .len()
            != 16
    {
        return Err("Invalid push keys".into());
    }
    Ok(())
}
pub async fn deliver(store: &Store) -> Result<()> {
    let subscriptions = query(&store.workspace()?, "SELECT * FROM push_subscriptions", &[])?;
    if subscriptions.is_empty() {
        return Ok(());
    }
    let keys = vapid(store)?;
    let notes = notifications(store, None, false)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    for row in subscriptions {
        let value: Value =
            serde_json::from_str(text(&row, "subscription")).map_err(|e| e.to_string())?;
        subscription(&value)?;
        let subscription: web_push::SubscriptionInfo =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        let mut attempts = 0;
        for note in notes.as_array().unwrap_or(&vec![]) {
            if note["read"] == json!(true) || text(note, "dueAt") < text(&row, "created_at") {
                continue;
            }
            let fingerprint = format!(
                "{:x}",
                Sha256::digest(
                    json!([note["title"], note["body"], note["dueAt"]])
                        .to_string()
                        .as_bytes()
                )
            );
            if first(
                &store.workspace()?,
                "SELECT fingerprint FROM push_deliveries WHERE endpoint=? AND notification_id=?",
                &[row["endpoint"].clone(), note["id"].clone()],
            )
            .map(|v| text(&v, "fingerprint") == fingerprint)
            .unwrap_or(false)
            {
                continue;
            }
            if attempts >= 20 {
                break;
            }
            attempts += 1;
            let mut signature = web_push::VapidSignatureBuilder::from_base64(
                text(&keys, "privateKey"),
                web_push::URL_SAFE_NO_PAD,
                &subscription,
            )
            .map_err(|e| e.to_string())?;
            signature.add_claim(
                "sub",
                std::env::var("VAPID_SUBJECT").unwrap_or("mailto:owner@example.com".into()),
            );
            let signature = signature.build().map_err(|e| e.to_string())?;
            let payload=json!({"title":note["title"],"body":note["body"],"href":note["href"],"id":note["id"]}).to_string();
            let mut message = web_push::WebPushMessageBuilder::new(&subscription);
            message.set_payload(web_push::ContentEncoding::Aes128Gcm, payload.as_bytes());
            message.set_vapid_signature(signature);
            let message = message.build().map_err(|e| e.to_string())?;
            let request = web_push::request_builder::build_request::<Vec<u8>>(message);
            let mut delivery = client.post(request.uri().to_string());
            for (name, value) in request.headers() {
                delivery = delivery.header(name.as_str(), value.as_bytes());
            }
            let response = delivery.body(request.into_body()).send().await;
            if let Ok(response) = response {
                if response.status().is_success() {
                    execute(&store.workspace()?,"INSERT INTO push_deliveries VALUES(?,?,?) ON CONFLICT(endpoint,notification_id) DO UPDATE SET fingerprint=excluded.fingerprint",&[row["endpoint"].clone(),note["id"].clone(),json!(fingerprint)])?;
                } else if matches!(response.status().as_u16(), 404 | 410) {
                    execute(
                        &store.workspace()?,
                        "DELETE FROM push_subscriptions WHERE endpoint=?",
                        &[row["endpoint"].clone()],
                    )?;
                    break;
                }
            }
        }
    }
    Ok(())
}

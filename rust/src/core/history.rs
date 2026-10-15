//! Owner pagination and model context have independent budgets and response contracts.
use super::*;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Default, Deserialize)]
pub struct PageQuery {
    pub before: Option<i64>,
    pub page: Option<bool>,
}
pub fn messages(
    store: &Store,
    conversation: &str,
    before: Option<i64>,
    limit: usize,
) -> Result<Value> {
    let db = store.open()?;
    if !db.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversations WHERE id=?)",
        [conversation],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(Error::NotFound);
    }
    let mut q=db.prepare("SELECT rowid,id,payload FROM messages WHERE conversation=? AND rowid<? ORDER BY rowid DESC LIMIT ?")?;
    let mut rows = q
        .query_map(
            params![conversation, before.unwrap_or(i64::MAX), limit + 1],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if more { rows.last().map(|r| r.0) } else { None };
    let items = rows
        .into_iter()
        .rev()
        .map(|(_, id, raw)| {
            let mut value: Value = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
            value
                .as_object_mut()
                .ok_or(Error::Storage)?
                .insert("messageId".into(), json!(id));
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"items":items,"nextCursor":cursor}))
}
pub fn conversations(store: &Store, before: Option<i64>) -> Result<Value> {
    let db = store.open()?;
    let mut q=db.prepare("SELECT c.rowid,c.id,c.app,c.title,EXISTS(SELECT 1 FROM authoring_sessions a WHERE a.conversation=c.id),(SELECT id FROM jobs j WHERE j.conversation=c.id AND j.state IN ('running','queued') ORDER BY j.rowid DESC LIMIT 1) FROM conversations c WHERE c.rowid<? AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation=c.id) ORDER BY c.rowid DESC LIMIT 101")?;
    let mut rows=q.query_map([before.unwrap_or(i64::MAX)],|r|Ok((r.get::<_,i64>(0)?,json!({"id":r.get::<_,String>(1)?,"app":r.get::<_,Option<String>>(2)?,"title":r.get::<_,String>(3)?,"build":r.get::<_,bool>(4)?,"job":r.get::<_,Option<String>>(5)?}))))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more = rows.len() > 100;
    rows.truncate(100);
    let cursor = if more { rows.last().map(|r| r.0) } else { None };
    Ok(json!({"items":rows.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"nextCursor":cursor}))
}
pub fn model_context(store: &Store, conversation: &str) -> Result<Value> {
    // At most 120 recent messages and 256 KiB of serialized text/tool content.
    // Image selection has its own separate cap in images::model_history.
    let page = messages(store, conversation, None, 120)?;
    let mut used = 0;
    let mut values = Vec::new();
    for value in page["items"].as_array().ok_or(Error::Storage)?.iter().rev() {
        let mut value = value.clone();
        value
            .as_object_mut()
            .ok_or(Error::Storage)?
            .remove("messageId");
        let bytes = value.to_string().len();
        if used + bytes > 256 * 1024 {
            break;
        }
        used += bytes;
        values.push(value);
    }
    values.reverse();
    Ok(json!(values))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pagination_is_complete_stable_and_separate_from_context() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db")).unwrap();
        let db = store.open().unwrap();
        db.execute("INSERT INTO conversations(id) VALUES('chat')", [])
            .unwrap();
        for i in 0..245 {
            db.execute(
                "INSERT INTO messages VALUES(?,'chat',?)",
                params![
                    format!("m{i}"),
                    json!({"role":"user","content":format!("message {i}")}).to_string()
                ],
            )
            .unwrap();
        }
        let first = messages(&store, "chat", None, 120).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 120);
        db.execute(
            "INSERT INTO messages VALUES('new','chat','{\"role\":\"user\",\"content\":\"new\"}')",
            [],
        )
        .unwrap();
        let second = messages(&store, "chat", first["nextCursor"].as_i64(), 120).unwrap();
        let third = messages(&store, "chat", second["nextCursor"].as_i64(), 120).unwrap();
        assert_eq!(third["items"].as_array().unwrap().len(), 5);
        assert!(third["nextCursor"].is_null());
        let mut ids = std::collections::BTreeSet::new();
        for page in [first, second, third] {
            for row in page["items"].as_array().unwrap() {
                assert!(ids.insert(row["messageId"].as_str().unwrap().to_owned()));
            }
        }
        assert_eq!(ids.len(), 245);
        let context = model_context(&store, "chat").unwrap();
        assert_eq!(context.as_array().unwrap().len(), 120);
        assert!(context[0].get("messageId").is_none());
        let plan:String=db.query_row("EXPLAIN QUERY PLAN SELECT payload FROM messages WHERE conversation='chat' ORDER BY rowid DESC LIMIT 120",[],|r|r.get(3)).unwrap();
        assert!(plan.contains("messages_conversation"));
    }
}

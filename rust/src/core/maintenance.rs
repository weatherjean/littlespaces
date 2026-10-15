//! Explicit owner maintenance. Recovery evidence and live data are never retention targets.
use super::*;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
pub struct Retention {
    pub keep_releases: usize,
    pub orphan_days: i64,
}
impl Default for Retention {
    fn default() -> Self {
        Self {
            keep_releases: 20,
            orphan_days: 30,
        }
    }
}
fn validate(policy: &Retention) -> Result<()> {
    if !(2..=1000).contains(&policy.keep_releases) || !(1..=3650).contains(&policy.orphan_days) {
        return Err(Error::Validation);
    }
    Ok(())
}
const OLD_RELEASES:&str="SELECT r.id FROM app_releases r WHERE (SELECT COUNT(*) FROM app_releases newer WHERE newer.app=r.app AND newer.rowid>r.rowid)>=? AND NOT EXISTS(SELECT 1 FROM release_plans p WHERE p.applied_release IS NULL AND p.app=r.app AND json_extract(p.report,'$.source.release')=r.id)";
fn candidates(db: &rusqlite::Connection, policy: &Retention) -> Result<Vec<String>> {
    let mut q = db.prepare(OLD_RELEASES)?;
    let rows = q
        .query_map([policy.keep_releases], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
pub fn status(store: &Store, policy: &Retention) -> Result<Value> {
    validate(policy)?;
    let db = store.open()?;
    let pages: i64 = db.pragma_query_value(None, "page_count", |r| r.get(0))?;
    let free: i64 = db.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
    let size: i64 = db.pragma_query_value(None, "page_size", |r| r.get(0))?;
    let mut categories = serde_json::Map::new();
    for (name,sql) in [
        ("images","SELECT COALESCE(SUM(length(data)),0) FROM images"),
        ("releaseSnapshots","SELECT COALESCE(SUM(length(before_records)+length(after_records)+length(before_sqlite)+length(after_sqlite)),0) FROM app_releases"),
        ("checkpoints","SELECT COALESCE(SUM(length(payload)),0) FROM agent_checkpoints"),
        ("messages","SELECT COALESCE(SUM(length(payload)),0) FROM messages"),
    ] {categories.insert(name.into(),json!(db.query_row(sql,[],|r|r.get::<_,i64>(0))?));}
    let recoverable:i64=db.query_row("SELECT COUNT(*) FROM jobs WHERE state IN ('running','queued','schedule_pending','interrupted')",[],|r|r.get(0))?;
    Ok(
        json!({"databaseBytes":pages*size,"reusableBytes":free*size,"categories":categories,"releasesEligible":candidates(&db,policy)?.len(),"activeOrInterruptedJobs":recoverable,"policy":policy}),
    )
}
pub fn cleanup(store: &Store, policy: &Retention) -> Result<Value> {
    validate(policy)?;
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let releases = candidates(&tx, policy)?;
    for id in &releases {
        tx.execute("DELETE FROM release_plans WHERE applied_release=?", [id])?;
        tx.execute("DELETE FROM app_releases WHERE id=?", [id])?;
    }
    let checkpoints = tx.execute(
        "DELETE FROM agent_checkpoints WHERE job IN (SELECT id FROM jobs WHERE state='completed')",
        [],
    )?;
    let events=tx.execute("DELETE FROM model_request_events WHERE job IN (SELECT id FROM jobs WHERE state='completed')",[])?;
    let diagnostics=tx.execute("DELETE FROM diagnostics WHERE id IN (SELECT d.id FROM diagnostics d WHERE (SELECT COUNT(*) FROM diagnostics n WHERE n.app=d.app AND n.revision=d.revision AND n.rowid>d.rowid)>=20)",[])?;
    let images=tx.execute("DELETE FROM images WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM app_images a WHERE a.image=images.id) AND NOT EXISTS(SELECT 1 FROM messages m,json_each(m.payload,'$.images') i WHERE i.value=images.id)",[notifications::now()-policy.orphan_days*86400000])?;
    tx.commit()?;
    Ok(
        json!({"releases":releases.len(),"checkpoints":checkpoints,"events":events,"diagnostics":diagnostics,"orphanImages":images}),
    )
}
/// Offline backups use SQLite's consistent snapshot export, never a live file copy.
pub fn backup(store: &Store, destination: &std::path::Path, key: &std::path::Path) -> Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(destination).map_err(|_| Error::Storage)?;
    let target = destination.join("workspace.sqlite");
    store.open()?.execute(
        "VACUUM INTO ?",
        params![target.to_str().ok_or(Error::Validation)?],
    )?;
    std::fs::copy(key, destination.join("secrets.key")).map_err(|_| Error::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["workspace.sqlite", "secrets.key"] {
            std::fs::set_permissions(
                destination.join(name),
                std::fs::Permissions::from_mode(0o600),
            )
            .map_err(|_| Error::Storage)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_preserves_only_referenced_snapshots_and_recent_releases() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db")).unwrap();
        let db = store.open().unwrap();
        db.execute("INSERT INTO apps(id,title) VALUES('app','App')", [])
            .unwrap();
        db.execute(
            "INSERT INTO revisions VALUES('revision','app','digest','{}')",
            [],
        )
        .unwrap();
        for i in 0..5 {
            db.execute(
                "INSERT INTO app_releases VALUES(?,'app','revision',NULL,'{}',x'','{}',x'','{}',?)",
                params![format!("r{i}"), i],
            )
            .unwrap();
        }
        db.execute("INSERT INTO release_plans VALUES('pending','app',NULL,'revision',NULL,0,NULL,NULL,'{}',x'','{\"source\":{\"release\":\"r0\"}}',0,NULL,0)",[]).unwrap();
        let policy = Retention {
            keep_releases: 2,
            orphan_days: 30,
        };
        assert_eq!(status(&store, &policy).unwrap()["releasesEligible"], 2);
        assert_eq!(cleanup(&store, &policy).unwrap()["releases"], 2);
        db.execute("DELETE FROM release_plans WHERE id='pending'", [])
            .unwrap();
        assert_eq!(cleanup(&store, &policy).unwrap()["releases"], 1);
        let mut q = db
            .prepare("SELECT id FROM app_releases ORDER BY rowid")
            .unwrap();
        let remaining = q
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining, vec!["r3", "r4"]);
    }
    #[test]
    fn stale_plan_does_not_deadlock_publication_at_release_cap() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db")).unwrap();
        let mut db = store.open().unwrap();
        db.execute(
            "INSERT INTO apps(id,title,record_version) VALUES('a','App',99)",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO revisions VALUES('v','a','digest','{}')", [])
            .unwrap();
        for n in 0..64 {
            db.execute(
                "INSERT INTO app_releases VALUES(?,'a','v',NULL,'{}',x'','{}',x'','{}',?)",
                params![format!("r{n}"), n],
            )
            .unwrap();
        }
        db.execute("INSERT INTO release_plans VALUES('stale','a',NULL,'v',NULL,0,NULL,NULL,'{}',x'','{}',0,NULL,0)",[]).unwrap();
        assert_eq!(
            cleanup(&store, &Retention::default()).unwrap()["releases"],
            44
        );
        let tx = db.transaction().unwrap();
        Store::record_release(
            &tx,
            &AppId("a".into()),
            &RevisionId("v".into()),
            None,
            &json!({}),
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(store
            .discard_release_plan(&AppId("wrong".into()), "stale")
            .is_err());
        store
            .discard_release_plan(&AppId("a".into()), "stale")
            .unwrap();
    }
    #[test]
    fn cleanup_keeps_live_images_messages_and_recoverable_checkpoints() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db")).unwrap();
        let db = store.open().unwrap();
        db.execute("INSERT INTO conversations(id) VALUES('c')", [])
            .unwrap();
        for (id, state) in [
            ("done", "completed"),
            ("unknown", "interrupted"),
            ("cancelled", "cancelled"),
        ] {
            db.execute(
                "INSERT INTO jobs(id,state,payload) VALUES(?,?,'{}')",
                params![id, state],
            )
            .unwrap();
            db.execute("INSERT INTO agent_checkpoints VALUES(?,'{}')", [id])
                .unwrap();
        }
        db.execute("INSERT INTO images VALUES('orphan','old','image/png',x'00',0),('kept','old','image/png',x'00',0)",[]).unwrap();
        db.execute(
            "INSERT INTO messages VALUES('m','c','{\"images\":[\"kept\"]}')",
            [],
        )
        .unwrap();
        let result = cleanup(&store, &Retention::default()).unwrap();
        assert_eq!(result["orphanImages"], 1);
        assert_eq!(result["checkpoints"], 1);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM agent_checkpoints", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT id FROM images", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "kept"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

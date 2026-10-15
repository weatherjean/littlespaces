//! Process health contains only counters and timestamps, never owner content or credentials.
use super::*;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc,
};
#[derive(Clone, Default)]
pub(crate) struct Operations(Arc<State>);
#[derive(Default)]
struct State {
    stopping: AtomicBool,
    scheduler: AtomicI64,
    push: AtomicI64,
    scheduler_failed: AtomicBool,
    push_failed: AtomicBool,
}
impl Operations {
    pub async fn stopped(&self) {
        while !self.stopping() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    pub fn stop(&self) {
        self.0.stopping.store(true, Ordering::SeqCst);
    }
    pub fn stopping(&self) -> bool {
        self.0.stopping.load(Ordering::SeqCst)
    }
    pub fn scheduler(&self, success: bool) {
        self.0.scheduler_failed.store(!success, Ordering::Relaxed);
        if success {
            self.0.scheduler.store(owner::now(), Ordering::Relaxed);
        }
    }
    pub fn push(&self, success: bool) {
        self.0.push_failed.store(!success, Ordering::Relaxed);
        if success {
            self.0.push.store(owner::now(), Ordering::Relaxed);
        }
    }
    pub fn healthy(&self) -> bool {
        !self.stopping()
            && !self.0.scheduler_failed.load(Ordering::Relaxed)
            && !self.0.push_failed.load(Ordering::Relaxed)
            && owner::now() - self.0.scheduler.load(Ordering::Relaxed) < 360
            && owner::now() - self.0.push.load(Ordering::Relaxed) < 60
    }
    pub fn status(&self) -> Value {
        json!({"stopping":self.stopping(),"backgroundHealthy":self.healthy(),
            "schedulerLastSuccess":self.0.scheduler.load(Ordering::Relaxed),
            "pushLastSuccess":self.0.push.load(Ordering::Relaxed),
            "schedulerFailed":self.0.scheduler_failed.load(Ordering::Relaxed),
            "pushFailed":self.0.push_failed.load(Ordering::Relaxed)})
    }
}
pub(crate) fn storage_health(store: &Store) -> Result<Value> {
    let mut db = store.open()?;
    // Probe write admission without changing persisted data.
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let queued: i64 = tx.query_row(
        "SELECT COUNT(*) FROM jobs WHERE state IN ('queued','schedule_pending')",
        [],
        |r| r.get(0),
    )?;
    let active: i64 = tx.query_row("SELECT COUNT(*) FROM jobs WHERE state='running'", [], |r| {
        r.get(0)
    })?;
    let attention: i64 = tx.query_row(
        "SELECT COUNT(*) FROM jobs WHERE state='interrupted'",
        [],
        |r| r.get(0),
    )?;
    let age:i64=tx.query_row("SELECT COALESCE(MAX(MAX(0,?-COALESCE(json_extract(payload,'$.updatedAt'),json_extract(payload,'$.startedAt'),?))),0) FROM jobs WHERE state IN ('queued','running')",[owner::now(),owner::now()],|r|r.get(0))?;
    let pages: i64 = tx.pragma_query_value(None, "page_count", |r| r.get(0))?;
    let size: i64 = tx.pragma_query_value(None, "page_size", |r| r.get(0))?;
    let free = store.available_disk_bytes()?;
    Ok(
        json!({"queuedJobs":queued,"runningJobs":active,"jobsNeedingReview":attention,"oldestJobProgressAgeSeconds":age,"databaseBytes":pages*size,"availableDiskBytes":free,"storageHealthy":free>=64*1024*1024}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_requires_worker_progress_and_rejects_shutdown() {
        let health = Operations::default();
        assert!(!health.healthy());
        health.scheduler(true);
        health.push(true);
        assert!(health.healthy());
        health.push(false);
        assert!(!health.healthy());
        health.push(true);
        health.stop();
        assert!(!health.healthy());
    }
}

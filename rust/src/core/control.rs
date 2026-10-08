use super::*;
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
#[derive(Clone, Default)]
pub struct Cancellation(Arc<Mutex<bool>>);
impl Cancellation {
    /// Serialized with the local commit gate. Once this returns, no later commit is possible.
    pub fn cancel(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn commit_gate(&self) -> Result<MutexGuard<'_, bool>> {
        let guard = self.0.lock().map_err(|_| Error::Cancelled)?;
        if *guard {
            return Err(Error::Cancelled);
        }
        Ok(guard)
    }
}
#[derive(Clone)]
pub(crate) struct Control {
    pub cancel: Cancellation,
    pub deadline: Instant,
}
impl Control {
    pub fn new(cancel: Cancellation, duration: Duration) -> Self {
        Self {
            cancel,
            deadline: Instant::now() + duration,
        }
    }
    pub fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.check_deadline()
    }
    pub fn check_deadline(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            return Err(Error::Deadline);
        }
        Ok(())
    }
    pub async fn cancelled(&self) {
        while !self.cancel.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
}
pub(crate) struct CancelOnDrop(pub Option<Cancellation>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(c) = &self.0 {
            c.cancel();
        }
    }
}

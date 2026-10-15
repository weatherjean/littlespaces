//! Durable model context and tool boundaries. A checkpoint never authorizes replay of an unknown write.
use super::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Checkpoint {
    pub budget: usize,
    pub input: Vec<Value>,
    pub output: Option<Vec<Value>>,
    pub cursor: usize,
    pub round: usize,
    pub calls: usize,
}
impl Store {
    pub(crate) fn checkpoint(&self, job: &str) -> Result<Option<Checkpoint>> {
        let raw: Option<String> = self
            .open()?
            .query_row(
                "SELECT payload FROM agent_checkpoints WHERE job=?",
                [job],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| serde_json::from_str(&s).map_err(|_| Error::Storage))
            .transpose()
    }
    pub(crate) fn save_checkpoint(&self, job: &str, checkpoint: &Checkpoint) -> Result<()> {
        let raw = serde_json::to_string(checkpoint).map_err(|_| Error::Storage)?;
        if raw.len() > 50 * 1024 * 1024 {
            return Err(Error::ContextLimit);
        }
        self.open()?.execute("INSERT INTO agent_checkpoints(job,payload) VALUES(?,?) ON CONFLICT(job) DO UPDATE SET payload=excluded.payload", params![job, raw])?;
        Ok(())
    }
    pub(crate) fn call_result(&self, job: &str, call: &str) -> Result<Option<Value>> {
        let row: Option<(String, String)> = self
            .open()?
            .query_row(
                "SELECT state,payload FROM agent_calls WHERE job=? AND call_id=?",
                params![job, call],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((state, payload)) if state == "completed" => Ok(Some(
                serde_json::from_str(&payload).map_err(|_| Error::Storage)?,
            )),
            Some(_) => Err(Error::RecoveryRequired),
        }
    }
}

impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            budget: 256,
            input: vec![],
            output: None,
            cursor: 0,
            round: 0,
            calls: 0,
        }
    }
}

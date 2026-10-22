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
    #[serde(default)]
    pub read_loop_start: usize,
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
            read_loop_start: 0,
        }
    }
}

// Keep the durable audit/checkpoint intact, but send an unchanged read result only once.
// Never remove writes, errors, unmatched calls, or different versions of a draft.
fn read_signature(call: &Value, output: &Value) -> Option<String> {
    let args: Value = serde_json::from_str(call["arguments"].as_str()?).ok()?;
    let readonly = match call["name"].as_str()? {
        "read_sdk" | "read_skill" => true,
        "authoring" => matches!(args["tool"].as_str(), Some("read_draft" | "read_sdk")),
        _ => false,
    };
    let result: Value = serde_json::from_str(output["output"].as_str()?).ok()?;
    if !readonly || result.get("error").is_some() || result.get("ok").is_none() {
        return None;
    }
    Some(serde_json::json!([call["name"], args, result["ok"]]).to_string())
}

pub(crate) fn model_input(input: &[Value]) -> Vec<Value> {
    let calls: std::collections::BTreeMap<_, _> = input
        .iter()
        .enumerate()
        .filter(|(_, item)| item["type"] == "function_call")
        .filter_map(|(index, item)| Some((item["call_id"].as_str()?, (index, item))))
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    let mut omitted = std::collections::BTreeSet::new();
    for (index, item) in input.iter().enumerate().rev() {
        if item["type"] != "function_call_output" {
            continue;
        }
        let Some((call_index, call)) = item["call_id"].as_str().and_then(|id| calls.get(id)) else {
            continue;
        };
        if let Some(signature) = read_signature(call, item) {
            if !seen.insert(signature) {
                omitted.insert(index);
                omitted.insert(*call_index);
            }
        }
    }
    input
        .iter()
        .enumerate()
        .filter(|(i, _)| !omitted.contains(i))
        .map(|(_, item)| item.clone())
        .collect()
}

pub(crate) fn repeated_reads(input: &[Value]) -> usize {
    let mut last = None;
    let mut count = 0;
    for item in input
        .iter()
        .rev()
        .filter(|item| item["type"] == "function_call_output")
    {
        let Some(call) = input
            .iter()
            .rev()
            .find(|call| call["type"] == "function_call" && call["call_id"] == item["call_id"])
        else {
            break;
        };
        let Some(signature) = read_signature(call, item) else {
            break;
        };
        if last.as_ref().is_some_and(|s| s != &signature) {
            break;
        }
        last = Some(signature);
        count += 1;
    }
    count
}

#[cfg(test)]
mod context_tests {
    use super::*;
    use serde_json::json;
    fn pair(id: usize, tool: &str, version: usize) -> Vec<Value> {
        vec![
            json!({"type":"function_call","call_id":id.to_string(),"name":"authoring","arguments":json!({"tool":tool}).to_string()}),
            json!({"type":"function_call_output","call_id":id.to_string(),"output":json!({"ok":{"version":version,"code":"x".repeat(32_000)},"execution":{"elapsedMs":id}}).to_string()}),
        ]
    }
    #[test]
    fn repeated_draft_reads_do_not_exhaust_context_or_delete_audit() {
        let mut input = vec![json!({"role":"user","content":"Build the requested app"})];
        for id in 0..30 {
            input.extend(pair(id, "read_draft", 3));
        }
        assert!(serde_json::to_vec(&input).unwrap().len() > 768 * 1024);
        let reduced = model_input(&input);
        assert_eq!(reduced.len(), 3);
        assert_eq!(input.len(), 61);
        assert_eq!(reduced[1]["call_id"], "29");
        assert_eq!(repeated_reads(&input), 30);
    }
    #[test]
    fn distinct_versions_writes_and_errors_are_retained() {
        let mut input = pair(1, "read_draft", 1);
        input.extend(pair(2, "read_draft", 2));
        input.extend(pair(3, "patch_draft", 2));
        input.extend(pair(4, "patch_draft", 2));
        assert_eq!(model_input(&input), input);
        assert_eq!(repeated_reads(&input), 0);
        for id in [5, 6] {
            let mut p = pair(id, "read_draft", 2);
            p[1]["output"] = json!(json!({"error":"storage"}).to_string());
            input.extend(p);
        }
        assert_eq!(model_input(&input), input);
        assert_eq!(repeated_reads(&input), 0);
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;

macro_rules! identity {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl $name {
            pub fn new() -> Self {
                Self(format!("{:032x}", rand::random::<u128>()))
            }
        }
        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}
identity!(AppId);
identity!(DraftId);
identity!(RevisionId);
identity!(InvocationId);
identity!(ConversationId);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionContract {
    pub name: String,
    pub read_only: bool,
    pub input: Value,
    pub output: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestCase {
    #[serde(default)]
    pub http: std::collections::BTreeMap<String, Value>,
    pub action: String,
    pub input: Value,
    pub expected: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppCode {
    pub backend: String,
    pub frontend: String,
    pub actions: Vec<ActionContract>,
    pub tests: Vec<TestCase>,
    #[serde(default)]
    pub frontend_tests: Vec<BrowserStep>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserStep {
    Fill { selector: String, value: String },
    Click { selector: String },
    Text { selector: String, contains: String },
}
impl AppCode {
    pub fn digest(&self) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).map_err(|_| Error::Storage)?)
        ))
    }
    pub fn validate(&self) -> Result<()> {
        if self.backend.len() > 32768
            || self.frontend.len() > 131072
            || self.actions.is_empty()
            || self.actions.len() > 16
            || self.tests.len() > 64
            || self.frontend_tests.len() > 32
            || serde_json::to_vec(self)
                .map_err(|_| Error::Validation)?
                .len()
                > 256 * 1024
        {
            return Err(Error::Limit);
        }
        let mut names = std::collections::BTreeSet::new();
        for action in &self.actions {
            if action.name.is_empty()
                || action.name.len() > 64
                || !action
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || action.name.as_bytes()[0].is_ascii_digit()
                || !names.insert(&action.name)
            {
                return Err(Error::Validation);
            }
            for schema in [&action.input, &action.output] {
                // No remote/file schema retrieval in authoring or execution.
                fn refs(v: &Value) -> bool {
                    match v {
                        Value::Object(o) => o.iter().any(|(k, v)| {
                            (k == "$ref" && !v.as_str().is_some_and(|s| s.starts_with('#')))
                                || refs(v)
                        }),
                        Value::Array(a) => a.iter().any(refs),
                        _ => false,
                    }
                }
                if refs(schema) || jsonschema::validator_for(schema).is_err() {
                    return Err(Error::Validation);
                }
            }
        }
        if self.tests.iter().any(|t| !names.contains(&t.action)) {
            return Err(Error::Validation);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Draft {
    pub id: DraftId,
    pub app: AppId,
    pub version: i64,
    pub code: AppCode,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Revision {
    pub id: RevisionId,
    pub app: AppId,
    pub digest: String,
    pub code: AppCode,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Error {
    Storage,
    NotFound,
    Validation,
    Conflict,
    Untested,
    ReadOnly,
    Cancelled,
    Deadline,
    Limit,
    Saturated,
    Script,
    MissingSecret,
    Network,
    ExternalUncertain,
    DuplicateInvocation,
    ApprovalRequired,
    Unauthorized,
    Model,
    Authentication,
    BrowserUnavailable,
    UsageLimit,
    UsageUnavailable,
    ModelIncomplete,
    StreamInterrupted,
}
pub type Result<T> = std::result::Result<T, Error>;
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

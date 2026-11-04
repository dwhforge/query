//! Structured host errors for IPC (ADR-0029).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Typed failure returned by host commands (JSON over IPC).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(tag = "kind")]
pub enum HostError {
    Validation { message: String },
    Conflict { message: String },
    Unsupported { message: String },
    Cancelled { message: String },
    Internal {
        message: String,
        correlation_id: String,
    },
}

impl HostError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation {
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict {
            message: message.into(),
        }
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::Unsupported {
            message: message.into(),
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::Cancelled {
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>, correlation_id: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            correlation_id: correlation_id.into(),
        }
    }

    /// Legacy string form for IPC paths that still expect `Err(String)`.
    pub fn to_legacy_string(&self) -> String {
        match self {
            Self::Validation { message }
            | Self::Conflict { message }
            | Self::Unsupported { message }
            | Self::Cancelled { message } => message.clone(),
            Self::Internal {
                message,
                correlation_id,
            } => format!("{message} (id={correlation_id})"),
        }
    }

    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| {
            serde_json::json!({ "kind": "internal", "message": "serialize HostError failed", "correlation_id": "n/a" })
        })
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_legacy_string())
    }
}

impl std::error::Error for HostError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_error_json_tagged() {
        let e = HostError::validation("bad check");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "validation");
        assert_eq!(v["message"], "bad check");
        let back: HostError = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }
}

/// Dispatch failure: legacy string or structured [HostError].
#[derive(Debug, Clone)]
pub enum RpcError {
    Message(String),
    Typed(HostError),
}

impl RpcError {
    pub fn message(&self) -> String {
        match self {
            Self::Message(m) => m.clone(),
            Self::Typed(e) => e.to_legacy_string(),
        }
    }

    pub fn detail(&self) -> Option<&HostError> {
        match self {
            Self::Message(_) => None,
            Self::Typed(e) => Some(e),
        }
    }
}

impl From<String> for RpcError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for RpcError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<HostError> for RpcError {
    fn from(value: HostError) -> Self {
        Self::Typed(value)
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

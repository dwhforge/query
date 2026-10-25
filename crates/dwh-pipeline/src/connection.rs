//! Project Connections — credentials / endpoint params (ADR-0012).
//! Distinct from Sources (objects) and Queries (transforms).

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_s3_provider() -> String {
    "config".into()
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    Postgres,
    S3,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PostgresParams {
    pub connection_string: String,
}

/// Maps to DuckDB `CREATE SECRET (TYPE s3, …)`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct S3Params {
    /// `config` (explicit keys) or `credential_chain` (env / profile / IMDS).
    #[serde(default = "default_s3_provider")]
    pub provider: String,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub access_key_id: Option<String>,
    #[serde(default)]
    pub secret_access_key: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    /// `path` or `vhost`
    #[serde(default)]
    pub url_style: Option<String>,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
    #[serde(default = "default_true")]
    pub verify_ssl: bool,
}

impl Default for S3Params {
    fn default() -> Self {
        Self {
            provider: default_s3_provider(),
            region: Some("us-east-1".into()),
            endpoint: None,
            access_key_id: None,
            secret_access_key: None,
            session_token: None,
            url_style: Some("path".into()),
            use_ssl: true,
            verify_ssl: true,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ConnectionDef {
    pub id: String,
    pub name: String,
    pub kind: ConnectionKind,
    #[serde(default)]
    pub postgres: Option<PostgresParams>,
    #[serde(default)]
    pub s3: Option<S3Params>,
}

impl ConnectionDef {
    pub fn postgres_dsn(&self) -> Option<&str> {
        self.postgres
            .as_ref()
            .map(|p| p.connection_string.as_str())
            .filter(|s| !s.is_empty())
    }
}

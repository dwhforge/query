//! Strip / merge connection secrets for on-disk Project vs local secrets store (ADR-0012 follow-up).

use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams, S3Params};
use crate::project::Project;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Secret payload for one connection (stored outside the project file).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct ConnectionSecret {
    #[serde(default)]
    pub postgres_connection_string: Option<String>,
    #[serde(default)]
    pub s3_access_key_id: Option<String>,
    #[serde(default)]
    pub s3_secret_access_key: Option<String>,
    #[serde(default)]
    pub s3_session_token: Option<String>,
}

impl ConnectionSecret {
    pub fn is_empty(&self) -> bool {
        self.postgres_connection_string
            .as_ref()
            .map(|s| s.is_empty())
            .unwrap_or(true)
            && self.s3_access_key_id.as_ref().map(|s| s.is_empty()).unwrap_or(true)
            && self
                .s3_secret_access_key
                .as_ref()
                .map(|s| s.is_empty())
                .unwrap_or(true)
            && self.s3_session_token.as_ref().map(|s| s.is_empty()).unwrap_or(true)
    }
}

/// On-disk secrets file shape (`~/.dwhforge-query/secrets.json`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct SecretsFile {
    /// Global connection secrets (`connection_id` → secret). Preferred store.
    #[serde(default)]
    pub connections: BTreeMap<String, ConnectionSecret>,
    /// Legacy: `project_id` → `connection_id` → secret (migrated into `connections`).
    #[serde(default)]
    pub projects: BTreeMap<String, BTreeMap<String, ConnectionSecret>>,
}

/// Merge `incoming` into `existing` without wiping filled fields.
pub fn merge_secret_prefer_existing(
    existing: &ConnectionSecret,
    incoming: &ConnectionSecret,
) -> ConnectionSecret {
    ConnectionSecret {
        postgres_connection_string: pick_secret(
            &existing.postgres_connection_string,
            &incoming.postgres_connection_string,
        ),
        s3_access_key_id: pick_secret(&existing.s3_access_key_id, &incoming.s3_access_key_id),
        s3_secret_access_key: pick_secret(
            &existing.s3_secret_access_key,
            &incoming.s3_secret_access_key,
        ),
        s3_session_token: pick_secret(&existing.s3_session_token, &incoming.s3_session_token),
    }
}

fn pick_secret(existing: &Option<String>, incoming: &Option<String>) -> Option<String> {
    match (existing, incoming) {
        (Some(e), _) if !e.is_empty() => Some(e.clone()),
        (_, Some(i)) if !i.is_empty() => Some(i.clone()),
        (Some(e), _) => Some(e.clone()),
        (_, other) => other.clone(),
    }
}

/// Upsert connection secrets into the global map (no overwrite of richer existing).
pub fn upsert_global_secrets(
    store: &mut SecretsFile,
    secrets: &BTreeMap<String, ConnectionSecret>,
) {
    for (id, incoming) in secrets {
        if incoming.is_empty() {
            continue;
        }
        match store.connections.get(id) {
            None => {
                store.connections.insert(id.clone(), incoming.clone());
            }
            Some(existing) => {
                let merged = merge_secret_prefer_existing(existing, incoming);
                store.connections.insert(id.clone(), merged);
            }
        }
    }
}

/// Move legacy per-project secrets into the global `connections` map.
pub fn migrate_legacy_project_secrets(store: &mut SecretsFile) {
    let legacy: Vec<(String, BTreeMap<String, ConnectionSecret>)> =
        store.projects.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (_project_id, map) in legacy {
        upsert_global_secrets(store, &map);
    }
    store.projects.clear();
}

/// Strip secrets from a connection list; return shells + secret map.
pub fn connections_for_disk(
    connections: &[ConnectionDef],
) -> (Vec<ConnectionDef>, BTreeMap<String, ConnectionSecret>) {
    let mut shells = Vec::with_capacity(connections.len());
    let mut secrets = BTreeMap::new();
    for conn in connections {
        let mut shell = conn.clone();
        let sec = extract_connection_secret(&shell);
        if !sec.is_empty() {
            secrets.insert(shell.id.clone(), sec);
        }
        strip_connection_secrets(&mut shell);
        shells.push(shell);
    }
    (shells, secrets)
}

/// Apply secret map onto a connection list (in place).
pub fn merge_connection_list_secrets(
    connections: &mut [ConnectionDef],
    secrets: &BTreeMap<String, ConnectionSecret>,
) {
    for conn in connections.iter_mut() {
        if let Some(sec) = secrets.get(&conn.id) {
            merge_connection_secret(conn, sec);
        }
    }
}

/// Pull secrets out of a connection; leave non-secret endpoint metadata in place.
pub fn extract_connection_secret(conn: &ConnectionDef) -> ConnectionSecret {
    let mut s = ConnectionSecret::default();
    if let Some(pg) = &conn.postgres {
        if !pg.connection_string.is_empty() {
            s.postgres_connection_string = Some(pg.connection_string.clone());
        }
    }
    if let Some(s3) = &conn.s3 {
        s.s3_access_key_id = s3.access_key_id.clone().filter(|x| !x.is_empty());
        s.s3_secret_access_key = s3.secret_access_key.clone().filter(|x| !x.is_empty());
        s.s3_session_token = s3.session_token.clone().filter(|x| !x.is_empty());
    }
    s
}

/// Remove secret fields from connection (for writing Project to disk).
pub fn strip_connection_secrets(conn: &mut ConnectionDef) {
    if let Some(pg) = conn.postgres.as_mut() {
        pg.connection_string.clear();
    }
    if let Some(s3) = conn.s3.as_mut() {
        s3.access_key_id = None;
        s3.secret_access_key = None;
        s3.session_token = None;
    }
}

/// Merge secrets back for runtime (preview / catalog).
pub fn merge_connection_secret(conn: &mut ConnectionDef, secret: &ConnectionSecret) {
    match conn.kind {
        ConnectionKind::Postgres => {
            if let Some(dsn) = &secret.postgres_connection_string {
                if !dsn.is_empty() {
                    match conn.postgres.as_mut() {
                        Some(pg) => pg.connection_string = dsn.clone(),
                        None => {
                            conn.postgres = Some(PostgresParams {
                                connection_string: dsn.clone(),
                            });
                        }
                    }
                }
            }
        }
        ConnectionKind::S3 => {
            let s3 = conn.s3.get_or_insert_with(S3Params::default);
            if let Some(v) = &secret.s3_access_key_id {
                s3.access_key_id = Some(v.clone());
            }
            if let Some(v) = &secret.s3_secret_access_key {
                s3.secret_access_key = Some(v.clone());
            }
            if let Some(v) = &secret.s3_session_token {
                s3.session_token = Some(v.clone());
            }
        }
    }
}

/// Project document safe to write: no `root_path`, **no connections** (global store).
///
/// Returns `(disk_project, secrets_extracted_from_any_inline_connections)` for
/// one-shot migration into the global secrets map. Connections are cleared on disk.
pub fn project_for_disk(project: &Project) -> (Project, BTreeMap<String, ConnectionSecret>) {
    let mut disk = project.clone();
    disk.root_path = None;
    let (_shells, secrets) = connections_for_disk(&disk.connections);
    // Connections are app-global — never persist them in the project file.
    disk.connections.clear();
    // Prefer connection_id; drop legacy inline DSN on sources when id present.
    for src in &mut disk.sources {
        if src.connection_id.is_some() {
            src.connection_string = None;
        }
    }
    (disk, secrets)
}

/// Apply a secret map onto the project's connections (in place).
pub fn merge_project_secrets(project: &mut Project, secrets: &BTreeMap<String, ConnectionSecret>) {
    merge_connection_list_secrets(&mut project.connections, secrets);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams};

    #[test]
    fn strip_and_merge_pg() {
        let mut c = ConnectionDef {
            id: "conn_local".into(),
            name: "local".into(),
            kind: ConnectionKind::Postgres,
            postgres: Some(PostgresParams {
                connection_string: "postgresql://u:p@localhost/db".into(),
            }),
            s3: None,
        };
        let sec = extract_connection_secret(&c);
        strip_connection_secrets(&mut c);
        assert!(c.postgres.as_ref().unwrap().connection_string.is_empty());
        merge_connection_secret(&mut c, &sec);
        assert_eq!(
            c.postgres.as_ref().unwrap().connection_string,
            "postgresql://u:p@localhost/db"
        );
    }

    #[test]
    fn project_for_disk_drops_root_and_secrets() {
        use crate::model::{QueryDef, TransformationStep, Workspace};
        use crate::producers::DbtTarget;
        use crate::dialect::WarehouseDialect;

        let p = Project {
            id: "proj_demo".into(),
            name: "demo".into(),
            root_path: Some("/abs/path/demo.dwhproj.json".into()),
            connections: vec![ConnectionDef {
                id: "conn_local".into(),
                name: "local".into(),
                kind: ConnectionKind::Postgres,
                postgres: Some(PostgresParams {
                    connection_string: "postgresql://u:p@localhost/db".into(),
                }),
                s3: None,
            }],
            sources: vec![],
            workspace: Workspace {
                queries: vec![QueryDef {
                    id: "q_main".into(),
                    name: "main".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "a.csv".into(),
                    }],
                    execution: Default::default(),
                }],
                focus_query_id: "q_main".into(),
            },
            dbt_target: DbtTarget::V1,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
        };
        let (disk, secrets) = project_for_disk(&p);
        assert!(disk.root_path.is_none());
        assert!(disk.connections.is_empty());
        assert_eq!(
            secrets.get("conn_local").unwrap().postgres_connection_string.as_deref(),
            Some("postgresql://u:p@localhost/db")
        );
        let json = disk.to_json_pretty().unwrap();
        assert!(!json.contains("root_path"));
        assert!(!json.contains("postgresql://"));
    }

    #[test]
    fn upsert_global_does_not_wipe_richer() {
        let mut store = SecretsFile::default();
        store.connections.insert(
            "c1".into(),
            ConnectionSecret {
                postgres_connection_string: Some("postgresql://keep".into()),
                ..Default::default()
            },
        );
        let mut incoming = BTreeMap::new();
        incoming.insert(
            "c1".into(),
            ConnectionSecret {
                postgres_connection_string: Some("postgresql://new".into()),
                ..Default::default()
            },
        );
        incoming.insert(
            "c2".into(),
            ConnectionSecret {
                postgres_connection_string: Some("postgresql://c2".into()),
                ..Default::default()
            },
        );
        upsert_global_secrets(&mut store, &incoming);
        assert_eq!(
            store
                .connections
                .get("c1")
                .unwrap()
                .postgres_connection_string
                .as_deref(),
            Some("postgresql://keep")
        );
        assert_eq!(
            store
                .connections
                .get("c2")
                .unwrap()
                .postgres_connection_string
                .as_deref(),
            Some("postgresql://c2")
        );
    }
}

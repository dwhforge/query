//! Strip / merge connection secrets for on-disk Project vs local secrets store (ADR-0012 follow-up).

use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams, S3Params};
use crate::model::{KeyMapStorage, TransformationStep};
use crate::project::Project;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

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
        // DuckDB file path is not a secret — nothing to merge.
        ConnectionKind::Duckdb => {}
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
    // ADR-0033: source KeyMaps are metadata-only on disk (editor draft may still hold rows).
    strip_source_keymap_row_bodies(&mut disk);
    (disk, secrets)
}

/// Clear source-map `entries` and matching ApplyKeyMap snapshots before serialize.
pub fn strip_source_keymap_row_bodies(project: &mut Project) {
    let source_ids: HashSet<String> = project
        .workspace
        .key_maps
        .iter()
        .filter(|m| matches!(m.storage, KeyMapStorage::Source { .. }))
        .map(|m| m.id.clone())
        .collect();
    for map in &mut project.workspace.key_maps {
        if matches!(map.storage, KeyMapStorage::Source { .. }) {
            map.entries.clear();
        }
    }
    for query in &mut project.workspace.queries {
        for step in &mut query.steps {
            if let TransformationStep::ApplyKeyMap { map_id, entries, .. } = step {
                if let Ok(id) = map_id.compiler_id() {
                    if source_ids.contains(id) {
                        entries.clear();
                    }
                }
            }
        }
    }
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
        duckdb: None,
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
            format_version: crate::project::PROJECT_FORMAT_VERSION,
            id: "proj_demo".into(),
            name: "demo".into(),
            project_uid: String::new(),
            references: vec![],
            connection_bindings: vec![],
            root_path: Some("/abs/path/demo.dwhproj.json".into()),
            connections: vec![ConnectionDef {
                id: "conn_local".into(),
                name: "local".into(),
                kind: ConnectionKind::Postgres,
                postgres: Some(PostgresParams {
                    connection_string: "postgresql://u:p@localhost/db".into(),
                }),
                s3: None,
            duckdb: None,
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
                key_maps: vec![],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: crate::destination::ExecutionEngine::Duckdb,
            destination: crate::destination::Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: crate::destination::Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
            mapping_checks: vec![],
            mapping_check_runs: vec![],
            pg_import: None,
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
    fn project_for_disk_strips_source_keymap_entries() {
        use crate::dialect::WarehouseDialect;
        use crate::model::{
            KeyMapDef, KeyMapEntry, KeyMapStorage, ObjectTarget, QueryDef, TransformationStep,
            Workspace,
        };
        use crate::producers::DbtTarget;

        let mut map = KeyMapDef::new("map_wh", "WH");
        map.entries = vec![KeyMapEntry::pair("a", "1")];
        map.storage = KeyMapStorage::Source {
            source: "public".into(),
            table: "aliases".into(),
            connection_id: Some("c1".into()),
            db_schema: None,
        };
        let p = Project {
            format_version: crate::project::PROJECT_FORMAT_VERSION,
            id: "proj".into(),
            name: "demo".into(),
            project_uid: String::new(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![],
            sources: vec![],
            workspace: Workspace {
                queries: vec![QueryDef {
                    id: "q".into(),
                    name: "q".into(),
                    steps: vec![TransformationStep::ApplyKeyMap {
                        column: "sku".into(),
                        columns: vec![],
                        output_column: None,
            output_bindings: vec![],
                        as_of_column: None,
                        map_id: ObjectTarget::Local("map_wh".into()),
                        entries: vec![KeyMapEntry::pair("a", "1")],
                    }],
                    execution: Default::default(),
                }],
                focus_query_id: "q".into(),
                key_maps: vec![map],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: crate::destination::ExecutionEngine::Duckdb,
            destination: crate::destination::Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: crate::destination::Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
            mapping_checks: vec![],
            mapping_check_runs: vec![],
            pg_import: None,
        };
        let (disk, _) = project_for_disk(&p);
        assert!(disk.workspace.key_maps[0].entries.is_empty());
        match &disk.workspace.queries[0].steps[0] {
            TransformationStep::ApplyKeyMap { entries, .. } => {
                assert!(entries.is_empty(), "ApplyKeyMap snapshot cleared");
            }
            _ => panic!("expected ApplyKeyMap"),
        }
        // Runtime draft unchanged.
        assert_eq!(p.workspace.key_maps[0].entries.len(), 1);
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

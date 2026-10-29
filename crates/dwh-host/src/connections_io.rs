//! Global connections: `~/.dwhforge-query/connections.json` (shells) + secrets.json.

use crate::secrets_io::{dwh_home_dir, load_secrets_file, save_secrets_file};
use dwh_pipeline::{
    connections_for_disk, merge_connection_list_secrets, migrate_legacy_project_secrets,
    upsert_global_secrets, ConnectionDef,
};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GlobalConnectionsFile {
    #[serde(default)]
    pub connections: Vec<ConnectionDef>,
}

pub fn connections_path() -> Result<std::path::PathBuf, String> {
    Ok(dwh_home_dir()?.join("connections.json"))
}

/// Load shells from disk and merge global secrets for runtime use.
pub fn load_global_connections() -> Result<Vec<ConnectionDef>, String> {
    let mut store = load_secrets_file()?;
    if !store.projects.is_empty() {
        migrate_legacy_project_secrets(&mut store);
        save_secrets_file(&store)?;
    }

    let path = connections_path()?;
    let mut conns = if path.is_file() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let file: GlobalConnectionsFile =
            serde_json::from_str(&raw).map_err(|e| format!("Invalid connections.json: {e}"))?;
        file.connections
    } else {
        Vec::new()
    };

    merge_connection_list_secrets(&mut conns, &store.connections);
    Ok(conns)
}

/// Persist connection shells (secrets stripped) and upsert secrets into secrets.json.
pub fn save_global_connections(connections: &[ConnectionDef]) -> Result<(), String> {
    let dir = dwh_home_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let (shells, secrets) = connections_for_disk(connections);
    let file = GlobalConnectionsFile {
        connections: shells,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(connections_path()?, json).map_err(|e| e.to_string())?;

    let mut store = load_secrets_file()?;
    if !store.projects.is_empty() {
        migrate_legacy_project_secrets(&mut store);
    }
    upsert_global_secrets(&mut store, &secrets);
    // Drop secrets for connection ids that no longer exist.
    let keep: std::collections::BTreeSet<&str> =
        connections.iter().map(|c| c.id.as_str()).collect();
    store.connections.retain(|id, _| keep.contains(id.as_str()));
    save_secrets_file(&store)?;
    Ok(())
}

/// Upsert project-local connections into the global store (migration).
/// Existing global shells/secrets win when already richer.
pub fn migrate_project_connections(project_conns: &[ConnectionDef]) -> Result<Vec<ConnectionDef>, String> {
    if project_conns.is_empty() {
        return load_global_connections();
    }
    let mut global = load_global_connections()?;
    let mut by_id: std::collections::BTreeMap<String, usize> = global
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.clone(), i))
        .collect();

    for incoming in project_conns {
        match by_id.get(&incoming.id).copied() {
            Some(idx) => {
                // Keep existing shell; only fill missing non-secret metadata lightly.
                let existing = &mut global[idx];
                if existing.name.is_empty() && !incoming.name.is_empty() {
                    existing.name = incoming.name.clone();
                }
            }
            None => {
                by_id.insert(incoming.id.clone(), global.len());
                global.push(incoming.clone());
            }
        }
    }
    save_global_connections(&global)?;
    load_global_connections()
}

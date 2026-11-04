//! Local secrets file: `~/.dwhforge-query/secrets.json` (mode 0600 when possible).

use crate::connections_io::{self, migrate_project_connections};
use dwh_pipeline::{
    ensure_project_uid, merge_project_secrets, migrate_legacy_project_secrets, project_for_disk,
    upsert_global_secrets, Project, SecretsFile,
};
use std::fs;
use std::path::{Path, PathBuf};

pub fn dwh_home_dir() -> Result<PathBuf, String> {
    let home = dirs_next_home().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home.join(".dwhforge-query"))
}

fn dirs_next_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub fn secrets_path() -> Result<PathBuf, String> {
    Ok(dwh_home_dir()?.join("secrets.json"))
}

pub fn load_secrets_file() -> Result<SecretsFile, String> {
    let path = secrets_path()?;
    if !path.is_file() {
        return Ok(SecretsFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid secrets.json: {e}"))
}

pub fn save_secrets_file(file: &SecretsFile) -> Result<(), String> {
    let dir = dwh_home_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("secrets.json");
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn save_project_with_secrets(path: &str, project: &Project) -> Result<Project, String> {
    let mut project = project.clone();
    project.format_version = dwh_pipeline::PROJECT_FORMAT_VERSION;
    // Mint a uid only when both memory and the file lack one (ADR-0025).
    ensure_project_uid(&mut project, Some(Path::new(path)));
    // Migrate any inline project connections into the global store first.
    if !project.connections.is_empty() {
        let _ = migrate_project_connections(&project.connections)?;
    }

    let (disk, extracted) = project_for_disk(&project);
    let json = disk.to_json_pretty()?;
    if let Some(parent) = PathBuf::from(path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup_if_format_upgrade(path)?;
    fs::write(path, json).map_err(|e| e.to_string())?;

    if !extracted.is_empty() {
        let mut store = load_secrets_file()?;
        if !store.projects.is_empty() {
            migrate_legacy_project_secrets(&mut store);
        }
        // Drop legacy per-project bucket for this project id.
        store.projects.remove(&project.id);
        upsert_global_secrets(&mut store, &extracted);
        save_secrets_file(&store)?;
    } else {
        // Still clear legacy project bucket if present.
        let mut store = load_secrets_file()?;
        if store.projects.remove(&project.id).is_some() {
            migrate_legacy_project_secrets(&mut store);
            save_secrets_file(&store)?;
        }
    }
    project.root_path = Some(path.to_string());
    Ok(project)
}

/// ADR-0030: if `path` exists and is an older format, copy to `<path>.bak`.
pub fn backup_if_format_upgrade(path: &str) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_file() {
        return Ok(());
    }
    let existing = fs::read_to_string(&path_buf).map_err(|e| e.to_string())?;
    let on_disk_ver = dwh_pipeline::peek_format_version(&existing);
    if on_disk_ver < dwh_pipeline::PROJECT_FORMAT_VERSION {
        let bak = format!("{path}.bak");
        fs::copy(&path_buf, &bak).map_err(|e| {
            format!("Failed to write backup before format upgrade ({bak}): {e}")
        })?;
    }
    Ok(())
}

pub fn load_project_with_secrets(path: &str) -> Result<Project, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut project = Project::from_json(&raw)?;
    project.root_path = None;

    // Migrate project-local connections (legacy files) into global, then attach runtime list.
    let global = if project.connections.is_empty() {
        connections_io::load_global_connections()?
    } else {
        migrate_project_connections(&project.connections)?
    };
    project.connections = global;

    // Legacy: secrets still under projects[id] — merge then migrate.
    let mut store = load_secrets_file()?;
    if let Some(map) = store.projects.get(&project.id).cloned() {
        merge_project_secrets(&mut project, &map);
        migrate_legacy_project_secrets(&mut store);
        upsert_global_secrets(
            &mut store,
            &project
                .connections
                .iter()
                .filter_map(|c| {
                    let s = dwh_pipeline::extract_connection_secret(c);
                    if s.is_empty() {
                        None
                    } else {
                        Some((c.id.clone(), s))
                    }
                })
                .collect(),
        );
        // Re-save global connections with any secrets that were only in legacy map.
        connections_io::save_global_connections(&project.connections)?;
    } else {
        merge_project_secrets(&mut project, &store.connections);
    }

    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dwh_pipeline::PROJECT_FORMAT_VERSION;

    #[test]
    fn backup_if_format_upgrade_writes_bak_for_v0() {
        let dir = std::env::temp_dir().join(format!("dwh_bak_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.dwhproj.json");
        let v0 = include_str!("../../dwh-pipeline/tests/fixtures/projects/v0_legacy_duckdb.json");
        fs::write(&path, v0).unwrap();
        assert_eq!(dwh_pipeline::peek_format_version(v0), 0);

        backup_if_format_upgrade(path.to_str().unwrap()).unwrap();
        let bak = PathBuf::from(format!("{}.bak", path.display()));
        assert!(bak.is_file());
        assert_eq!(fs::read_to_string(&bak).unwrap(), v0);

        // Current version: no further bak overwrite required for equal version.
        let mut upgraded = Project::from_json(v0).unwrap();
        upgraded.format_version = PROJECT_FORMAT_VERSION;
        fs::write(&path, upgraded.to_json_pretty().unwrap()).unwrap();
        let bak_before = fs::read_to_string(&bak).unwrap();
        backup_if_format_upgrade(path.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), bak_before);

        let _ = fs::remove_dir_all(&dir);
    }
}

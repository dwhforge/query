//! Local secrets file: `~/.dwhforge-query/secrets.json` (mode 0600 when possible).

use crate::atomic_fs::{atomic_write, atomic_write_with_mode};
use crate::connections_io::{self, migrate_project_connections};
use dwh_pipeline::{
    ensure_project_uid, merge_project_secrets, migrate_legacy_project_secrets, project_for_disk,
    upsert_global_secrets, Project, SecretsFile, PROJECT_FORMAT_VERSION,
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
    // Serialize/validate JSON before touching the destination; mode 0600 from create.
    let outcome = atomic_write_with_mode(&path, json.as_bytes(), Some(0o600))?;
    if let crate::atomic_fs::AtomicWriteOutcome::PostCommitDirSync { message } = outcome {
        // Content is published; durability of the dir entry is best-effort.
        eprintln!("[dwh-host] secrets post-commit: {message}");
    }
    Ok(())
}

/// Refuse to publish over an on-disk future format (no silent downgrade).
pub fn refuse_unsupported_on_disk_format(path: &str) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_file() {
        return Ok(());
    }
    let existing = fs::read_to_string(&path_buf).map_err(|e| e.to_string())?;
    let on_disk_ver = dwh_pipeline::peek_format_version(&existing);
    if on_disk_ver > PROJECT_FORMAT_VERSION {
        return Err(format!(
            "Refusing to overwrite unsupported project format_version {on_disk_ver} \
             (this app supports ≤ {PROJECT_FORMAT_VERSION}). Open with a newer build."
        ));
    }
    Ok(())
}

pub fn save_project_with_secrets(path: &str, project: &Project) -> Result<Project, String> {
    let mut project = project.clone();
    project.format_version = PROJECT_FORMAT_VERSION;
    // Mint a uid only when both memory and the file lack one (ADR-0025).
    ensure_project_uid(&mut project, Some(Path::new(path)));
    // Migrate any inline project connections into the global store first.
    if !project.connections.is_empty() {
        let _ = migrate_project_connections(&project.connections)?;
    }

    let (disk, extracted) = project_for_disk(&project);
    // Validate serialization before any destination mutation.
    let json = disk.to_json_pretty()?;
    refuse_unsupported_on_disk_format(path)?;
    if let Some(parent) = PathBuf::from(path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup_if_format_upgrade(path)?;
    let outcome = atomic_write(Path::new(path), json.as_bytes())?;
    if let crate::atomic_fs::AtomicWriteOutcome::PostCommitDirSync { message } = outcome {
        eprintln!("[dwh-host] project post-commit: {message}");
    }

    // Secrets/connections are separate files — not one ACID transaction with the
    // project. A crash after project publish but before secrets update can leave
    // credentials stale; the project file itself remains parseable.
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
/// Does not overwrite an existing `.bak` when versions are equal (retry-safe).
pub fn backup_if_format_upgrade(path: &str) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_file() {
        return Ok(());
    }
    let existing = fs::read_to_string(&path_buf).map_err(|e| e.to_string())?;
    let on_disk_ver = dwh_pipeline::peek_format_version(&existing);
    if on_disk_ver < PROJECT_FORMAT_VERSION {
        let bak = format!("{path}.bak");
        let bak_path = PathBuf::from(&bak);
        if bak_path.is_file() {
            // Keep the first upgrade backup; do not replace with a partial/newer copy.
            return Ok(());
        }
        fs::copy(&path_buf, &bak_path).map_err(|e| {
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
    use std::sync::{Mutex, OnceLock};

    fn home_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

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

        // Retry while still on v0 content must not clobber the first .bak.
        fs::write(&path, v0).unwrap();
        backup_if_format_upgrade(path.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), bak_before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuse_future_format_on_save() {
        let dir = std::env::temp_dir().join(format!("dwh_future_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("future.dwhproj.json");
        let future = format!(
            r#"{{"id":"p","name":"t","format_version":{},"connections":[],"sources":[],"workspace":{{"queries":[],"focus_query_id":"","key_maps":[]}},"dbt_target":"v1"}}"#,
            PROJECT_FORMAT_VERSION + 7
        );
        fs::write(&path, &future).unwrap();
        let err = refuse_unsupported_on_disk_format(path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("Refusing to overwrite"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), future);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_project_round_trip_atomic_isolated_home() {
        let _guard = home_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "dwh_home_save_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);

        let proj_dir = home.join("proj");
        fs::create_dir_all(&proj_dir).unwrap();
        let path = proj_dir.join("p.dwhproj.json");
        let v0 = include_str!("../../dwh-pipeline/tests/fixtures/projects/v0_legacy_duckdb.json");
        fs::write(&path, v0).unwrap();

        let project = Project::from_json(v0).unwrap();
        let saved = save_project_with_secrets(path.to_str().unwrap(), &project).unwrap();
        assert_eq!(saved.format_version, PROJECT_FORMAT_VERSION);
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(
            on_disk.contains("\"format_version\": 1") || on_disk.contains("\"format_version\":1"),
            "stamped format_version missing: {on_disk}"
        );
        let bak = PathBuf::from(format!("{}.bak", path.display()));
        assert!(bak.is_file(), "v0 upgrade must leave .bak");
        assert_eq!(fs::read_to_string(&bak).unwrap(), v0);
        let reloaded = load_project_with_secrets(path.to_str().unwrap()).unwrap();
        assert_eq!(reloaded.format_version, PROJECT_FORMAT_VERSION);

        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(&home);
    }
}

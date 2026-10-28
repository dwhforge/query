//! Safe re-export: manifest + content hashes (ADR-0018 §3).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = ".dwhforge-export.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExportManifest {
    pub version: u32,
    pub pipeline_name: String,
    pub dialect: String,
    /// Relative path → sha256 hex of file contents (LF-normalized for text).
    pub owned: BTreeMap<String, String>,
}

impl ExportManifest {
    pub fn new(pipeline_name: &str, dialect: &str, files: &BTreeMap<String, String>) -> Self {
        let mut owned = BTreeMap::new();
        for (path, content) in files {
            owned.insert(path.clone(), hash_content(content));
        }
        Self {
            version: 1,
            pipeline_name: pipeline_name.to_string(),
            dialect: dialect.to_string(),
            owned,
        }
    }
}

pub fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn manifest_path(export_root: &Path) -> PathBuf {
    export_root.join(MANIFEST_FILE)
}

pub fn load_manifest(export_root: &Path) -> Result<Option<ExportManifest>, String> {
    let p = manifest_path(export_root);
    if !p.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let m: ExportManifest =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", p.display()))?;
    Ok(Some(m))
}

/// Check disk against prior manifest. Returns conflicting relative paths.
pub fn find_conflicts(export_root: &Path, prior: &ExportManifest) -> Result<Vec<String>, String> {
    let mut conflicts = Vec::new();
    for (rel, expected_hash) in &prior.owned {
        let path = export_root.join(rel);
        if !path.is_file() {
            // Missing owned file: allow overwrite (treat as not hand-edited).
            continue;
        }
        let on_disk = fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if hash_content(&on_disk) != *expected_hash {
            conflicts.push(rel.clone());
        }
    }
    Ok(conflicts)
}

/// Write planned files only after conflict check. Removes stale owned paths. Writes new manifest.
pub fn commit_export_plan(
    export_root: &Path,
    pipeline_name: &str,
    dialect: &str,
    planned: &BTreeMap<String, String>,
) -> Result<(), String> {
    if let Some(prior) = load_manifest(export_root)? {
        let conflicts = find_conflicts(export_root, &prior)?;
        if !conflicts.is_empty() {
            return Err(format!(
                "export refused: hand-edited generator-owned file(s) (ADR-0018). \
                 Revert or remove edits, then export again. Conflicts:\n  - {}",
                conflicts.join("\n  - ")
            ));
        }
        // Stale owned paths — delete after conflict check passed.
        for rel in prior.owned.keys() {
            if !planned.contains_key(rel) {
                let path = export_root.join(rel);
                if path.is_file() {
                    fs::remove_file(&path)
                        .map_err(|e| format!("remove stale {}: {e}", path.display()))?;
                }
            }
        }
    }

    for (rel, content) in planned {
        let path = export_root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    }

    let manifest = ExportManifest::new(pipeline_name, dialect, planned);
    let man_path = manifest_path(export_root);
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(&man_path, format!("{json}\n")).map_err(|e| format!("write {}: {e}", man_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn refuse_hand_edit_before_write() {
        let root = temp_dir().join(format!("dwh_manif_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let mut plan1 = BTreeMap::new();
        plan1.insert("models/a.sql".into(), "select 1\n".into());
        plan1.insert("dbt_project.yml".into(), "name: x\n".into());
        commit_export_plan(&root, "demo", "duckdb", &plan1).unwrap();

        fs::write(root.join("models/a.sql"), "select 2 -- hand\n").unwrap();

        let mut plan2 = plan1.clone();
        plan2.insert("models/a.sql".into(), "select 1\n".into());
        let err = commit_export_plan(&root, "demo", "duckdb", &plan2).unwrap_err();
        assert!(err.contains("hand-edited"));
        assert!(err.contains("models/a.sql"));
        // Unchanged on disk after refuse
        let disk = fs::read_to_string(root.join("models/a.sql")).unwrap();
        assert!(disk.contains("hand"));
    }

    #[test]
    fn noop_reexport_ok_and_stale_removed() {
        let root = temp_dir().join(format!("dwh_manif2_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let mut plan1 = BTreeMap::new();
        plan1.insert("models/a.sql".into(), "select 1\n".into());
        plan1.insert("models/b.sql".into(), "select 2\n".into());
        commit_export_plan(&root, "demo", "duckdb", &plan1).unwrap();

        // User sidecar — unowned
        fs::write(root.join("notes.txt"), "keep me").unwrap();

        let mut plan2 = BTreeMap::new();
        plan2.insert("models/a.sql".into(), "select 1\n".into());
        commit_export_plan(&root, "demo", "duckdb", &plan2).unwrap();

        assert!(!root.join("models/b.sql").exists());
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "keep me"
        );
        assert_eq!(
            fs::read_to_string(root.join("models/a.sql")).unwrap(),
            "select 1\n"
        );
    }
}

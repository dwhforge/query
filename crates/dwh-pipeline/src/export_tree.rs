//! List files under a dbt export root for Explorer / CLI.

use serde::Serialize;
use std::fs;
use std::path::Path;

/// Result of `export_dbt` (path + relative file tree + optional offline parse).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportResult {
    pub path: String,
    /// Relative paths under `path`, directories end with `/`, sorted.
    pub files: Vec<String>,
    /// `dbt parse` succeeded (false if skipped failure / missing dbt / parse error).
    #[serde(default)]
    pub dbt_parse_ok: bool,
    /// Captured parse log (truncated); empty when validate was not requested.
    #[serde(default)]
    pub dbt_parse_log: String,
}

impl ExportResult {
    pub fn with_files(path: String, files: Vec<String>) -> Self {
        Self {
            path,
            files,
            dbt_parse_ok: false,
            dbt_parse_log: String::new(),
        }
    }
}

/// Walk `root` and return sorted relative paths (dirs end with `/`).
pub fn list_export_tree(root: &str) -> Result<Vec<String>, String> {
    let root = Path::new(root);
    if !root.is_dir() {
        return Err(format!(
            "export path is not a directory: {}",
            root.display()
        ));
    }
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if path.is_dir() {
            out.push(format!("{rel}/"));
            walk(root, &path, out)?;
        } else if path.is_file() {
            out.push(rel);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;
    use std::fs::{create_dir_all, remove_dir_all, write};

    #[test]
    fn lists_sorted_tree() {
        let root = temp_dir().join(format!("dwh_export_tree_{}", std::process::id()));
        let _ = remove_dir_all(&root);
        create_dir_all(root.join("models/staging")).unwrap();
        write(root.join("dbt_project.yml"), "x").unwrap();
        write(root.join("models/sources.yml"), "y").unwrap();
        write(root.join("models/staging/stg_a.sql"), "z").unwrap();

        let files = list_export_tree(root.to_str().unwrap()).unwrap();
        assert_eq!(
            files,
            vec![
                "dbt_project.yml".to_string(),
                "models/".to_string(),
                "models/sources.yml".to_string(),
                "models/staging/".to_string(),
                "models/staging/stg_a.sql".to_string(),
            ]
        );
        let _ = remove_dir_all(&root);
    }
}

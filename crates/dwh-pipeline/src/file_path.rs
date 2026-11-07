//! Project file paths with explicit absolute/relative kind ([ADR-0043](../../../docs/adr/0043-project-relative-load-paths.md)).

use crate::model::{TransformationStep, Workspace};
use crate::project::{Project, SourceDef, SourceKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Authoring semantics for a stored file locator. Runtime trusts this flag.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FilePathKind {
    #[default]
    Absolute,
    Relative,
}

impl FilePathKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Absolute => "absolute",
            Self::Relative => "relative",
        }
    }
}

/// Cross-platform “looks absolute” for migration / tooling only — not for runtime trust.
/// Must not rely on host [`Path::is_absolute`] alone (Windows paths on Linux, etc.).
pub fn looks_absolute_cross_platform(path: &str) -> bool {
    let p = path.trim();
    if p.is_empty() {
        return false;
    }
    let lower = p.to_ascii_lowercase();
    if lower.starts_with("s3://") {
        return true;
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return true;
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return true;
    }
    false
}

/// Normalize a relative locator for on-disk storage (forward slashes, no drive tricks).
pub fn portable_relative(path: &str) -> String {
    path.trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

/// Resolve a stored path for engines (DuckDB / export SQL).
pub fn resolve_for_engine(
    project_file: Option<&Path>,
    path: &str,
    kind: FilePathKind,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("file path is empty".into());
    }
    if looks_absolute_cross_platform(trimmed) && trimmed.to_ascii_lowercase().starts_with("s3://") {
        return Ok(trimmed.to_string());
    }
    match kind {
        FilePathKind::Absolute => Ok(trimmed.to_string()),
        FilePathKind::Relative => {
            let Some(pf) = project_file.filter(|p| !p.as_os_str().is_empty()) else {
                return Err(
                    "Save the project first — relative Load paths resolve against the project file"
                        .into(),
                );
            };
            let base = pf.parent().unwrap_or_else(|| Path::new("."));
            let joined = base.join(portable_relative(trimmed));
            Ok(joined.to_string_lossy().to_string())
        }
    }
}

/// If `absolute` is under `project_file`'s directory, return a portable relative string.
pub fn try_relativize(project_file: &Path, absolute: &str) -> Option<String> {
    let trimmed = absolute.trim();
    if trimmed.is_empty() || trimmed.to_ascii_lowercase().starts_with("s3://") {
        return None;
    }
    if !looks_absolute_cross_platform(trimmed) {
        // Already relative-looking — just portable-normalize.
        let rel = portable_relative(trimmed);
        return if rel.is_empty() { None } else { Some(rel) };
    }
    let base = project_file.parent().unwrap_or_else(|| Path::new("."));
    let base_c = std::fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let target = PathBuf::from(trimmed);
    let target_c = std::fs::canonicalize(&target).unwrap_or(target);
    let rel = target_c.strip_prefix(&base_c).ok()?;
    let s = portable_relative(&rel.to_string_lossy());
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn stamp_kind(path: &str) -> FilePathKind {
    if looks_absolute_cross_platform(path) {
        FilePathKind::Absolute
    } else {
        FilePathKind::Relative
    }
}

/// Rewrite absolute paths under the project dir to relative + kind (ADR-0043 Save).
pub fn relativize_project_file_paths(project_file: &Path, project: &mut Project) {
    for q in &mut project.workspace.queries {
        for step in &mut q.steps {
            relativize_step(project_file, step);
        }
    }
    for s in &mut project.sources {
        relativize_source(project_file, s);
    }
}

fn relativize_step(project_file: &Path, step: &mut TransformationStep) {
    match step {
        TransformationStep::LoadCsv { path, path_kind }
        | TransformationStep::LoadParquet {
            path, path_kind, ..
        } => {
            if *path_kind == FilePathKind::Relative {
                *path = portable_relative(path);
                return;
            }
            if let Some(rel) = try_relativize(project_file, path) {
                *path = rel;
                *path_kind = FilePathKind::Relative;
            }
        }
        TransformationStep::LoadDuckdb {
            path,
            path_kind,
            connection_id,
            ..
        } => {
            if connection_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false) {
                return;
            }
            if path.trim().is_empty() {
                return;
            }
            if *path_kind == FilePathKind::Relative {
                *path = portable_relative(path);
                return;
            }
            if let Some(rel) = try_relativize(project_file, path) {
                *path = rel;
                *path_kind = FilePathKind::Relative;
            }
        }
        _ => {}
    }
}

fn relativize_source(project_file: &Path, source: &mut SourceDef) {
    if !matches!(source.kind, SourceKind::Csv | SourceKind::Parquet | SourceKind::Duckdb) {
        return;
    }
    let Some(path) = source.path.as_mut() else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    // Remote parquet stays absolute.
    if source.connection_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
        && source.kind == SourceKind::Parquet
    {
        source.path_kind = FilePathKind::Absolute;
        return;
    }
    if source.path_kind == FilePathKind::Relative {
        *path = portable_relative(path);
        return;
    }
    if let Some(rel) = try_relativize(project_file, path) {
        *path = rel;
        source.path_kind = FilePathKind::Relative;
    }
}

/// Expand relative paths to host-absolute for engines (ephemeral copy).
pub fn resolve_workspace_file_paths(
    project_file: Option<&Path>,
    workspace: &mut Workspace,
    sources: &mut [SourceDef],
) -> Result<(), String> {
    for q in &mut workspace.queries {
        for step in &mut q.steps {
            resolve_step(project_file, step)?;
        }
    }
    for s in sources.iter_mut() {
        resolve_source(project_file, s)?;
    }
    Ok(())
}

fn resolve_step(project_file: Option<&Path>, step: &mut TransformationStep) -> Result<(), String> {
    match step {
        TransformationStep::LoadCsv { path, path_kind }
        | TransformationStep::LoadParquet {
            path, path_kind, ..
        } => {
            *path = resolve_for_engine(project_file, path, *path_kind)?;
            *path_kind = FilePathKind::Absolute;
            Ok(())
        }
        TransformationStep::LoadDuckdb {
            path,
            path_kind,
            connection_id,
            ..
        } => {
            if connection_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false) {
                return Ok(());
            }
            if path.trim().is_empty() {
                return Ok(());
            }
            *path = resolve_for_engine(project_file, path, *path_kind)?;
            *path_kind = FilePathKind::Absolute;
            Ok(())
        }
        _ => Ok(()),
    }
}

fn resolve_source(project_file: Option<&Path>, source: &mut SourceDef) -> Result<(), String> {
    if !matches!(source.kind, SourceKind::Csv | SourceKind::Parquet | SourceKind::Duckdb) {
        return Ok(());
    }
    let Some(path) = source.path.as_ref() else {
        return Ok(());
    };
    if path.trim().is_empty() {
        return Ok(());
    }
    if source.connection_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
        && source.kind == SourceKind::Parquet
    {
        return Ok(());
    }
    let resolved = resolve_for_engine(project_file, path, source.path_kind)?;
    source.path = Some(resolved);
    source.path_kind = FilePathKind::Absolute;
    Ok(())
}

/// JSON migrate helper: stamp `path_kind` on Load payloads and sources.
pub fn stamp_path_kind_in_json(obj: &mut serde_json::Map<String, serde_json::Value>) {
    use serde_json::{json, Value};
    if let Some(sources) = obj.get_mut("sources").and_then(|s| s.as_array_mut()) {
        for s in sources {
            let Some(o) = s.as_object_mut() else { continue };
            let kind = o.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            if !matches!(kind, "csv" | "parquet" | "duckdb") {
                continue;
            }
            if o.get("path_kind").is_some() {
                continue;
            }
            let path = o.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() {
                continue;
            }
            o.insert(
                "path_kind".into(),
                Value::String(stamp_kind(path).as_str().into()),
            );
        }
    }
    let Some(ws) = obj.get_mut("workspace").and_then(|w| w.as_object_mut()) else {
        return;
    };
    let Some(queries) = ws.get_mut("queries").and_then(|q| q.as_array_mut()) else {
        return;
    };
    for query in queries {
        let Some(steps) = query
            .as_object_mut()
            .and_then(|q| q.get_mut("steps"))
            .and_then(|s| s.as_array_mut())
        else {
            continue;
        };
        for step in steps {
            let Some(s) = step.as_object_mut() else { continue };
            let ty = s.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if !matches!(ty, "LoadCsv" | "LoadParquet" | "LoadDuckdb") {
                continue;
            }
            // tagged: { type, payload: { path, ... } } or flat
            let payload = if let Some(p) = s.get_mut("payload").and_then(|p| p.as_object_mut()) {
                p
            } else {
                s
            };
            if payload.get("path_kind").is_some() {
                continue;
            }
            let path = payload.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() {
                continue;
            }
            payload.insert(
                "path_kind".into(),
                json!(stamp_kind(path).as_str()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_cross_platform() {
        assert!(looks_absolute_cross_platform("/tmp/a.csv"));
        assert!(looks_absolute_cross_platform(r"C:\data\a.csv"));
        assert!(looks_absolute_cross_platform(r"D:/data/a.csv"));
        assert!(looks_absolute_cross_platform(r"\\server\share\a.csv"));
        assert!(looks_absolute_cross_platform("s3://bucket/a.csv"));
        assert!(!looks_absolute_cross_platform("data/a.csv"));
        assert!(!looks_absolute_cross_platform(r"data\a.csv"));
        assert!(!looks_absolute_cross_platform("./data/a.csv"));
    }

    #[test]
    fn resolve_relative_joins_project_dir() {
        let pf = Path::new("/repo/app.dwhproj.json");
        let got = resolve_for_engine(Some(pf), "data/a.csv", FilePathKind::Relative).unwrap();
        assert!(got.replace('\\', "/").ends_with("/repo/data/a.csv") || got.ends_with("repo/data/a.csv"));
    }

    #[test]
    fn resolve_relative_needs_project_file() {
        let err = resolve_for_engine(None, "data/a.csv", FilePathKind::Relative).unwrap_err();
        assert!(err.contains("Save the project"));
    }

    #[test]
    fn portable_slashes() {
        assert_eq!(portable_relative(r"data\crm.csv"), "data/crm.csv");
        assert_eq!(portable_relative("./data/crm.csv"), "data/crm.csv");
    }
}

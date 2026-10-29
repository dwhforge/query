//! Sidecar DuckDB extensions — one folder next to the app, LOAD only (no INSTALL).
//!
//! Canonical layout (shipped with the binary):
//!
//! ```text
//! DWH-RS-QUERY          # app / CLI binary (bundled DuckDB inside)
//! extensions/
//!   postgres_scanner.duckdb_extension
//!   httpfs.duckdb_extension
//!   aws.duckdb_extension
//! ```
//!
//! Override: `DWH_EXTENSIONS_DIR=/absolute/path/to/extensions`

use duckdb::Connection;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct ExtSpec {
    load_name: &'static str,
    files: &'static [&'static str],
}

const POSTGRES: ExtSpec = ExtSpec {
    load_name: "postgres",
    files: &[
        "postgres_scanner.duckdb_extension",
        "postgres.duckdb_extension",
    ],
};

const HTTPFS: ExtSpec = ExtSpec {
    load_name: "httpfs",
    files: &["httpfs.duckdb_extension"],
};

const AWS: ExtSpec = ExtSpec {
    load_name: "aws",
    files: &["aws.duckdb_extension"],
};

/// Optional — not shipped by default (ADR-0011). Loaded only if present in sidecar.
const SPATIAL: ExtSpec = ExtSpec {
    load_name: "spatial",
    files: &["spatial.duckdb_extension"],
};

/// Optional directory set by the host (`DWH_EXTENSIONS_DIR` / tests) before session start.
static EXTENSIONS_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// Pin the extensions folder (call once from `dwh-host` before `DbSession::new`).
pub fn set_extensions_dir(dir: PathBuf) {
    let _ = EXTENSIONS_DIR_OVERRIDE.set(dir);
}

pub fn duckdb_version_tag(conn: &Connection) -> Result<String, String> {
    let v: String = conn
        .query_row("SELECT version()", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let token = v.split_whitespace().next().unwrap_or(&v);
    Ok(if token.starts_with('v') {
        token.to_string()
    } else {
        format!("v{token}")
    })
}

pub fn duckdb_platform() -> String {
    let os = match env::consts::OS {
        "linux" => "linux",
        "macos" => "osx",
        "windows" => "windows",
        other => other,
    };
    let arch = match env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}_{arch}")
}

/// Resolve the single extensions folder (prefer next to the app).
pub fn resolve_extensions_dir() -> Option<PathBuf> {
    if let Some(dir) = EXTENSIONS_DIR_OVERRIDE.get() {
        if dir.is_dir() {
            return Some(dir.clone());
        }
    }
    if let Ok(custom) = env::var("DWH_EXTENSIONS_DIR") {
        let p = PathBuf::from(custom);
        if p.is_dir() {
            return Some(p);
        }
    }
    // Legacy alias
    if let Ok(custom) = env::var("DWH_DUCKDB_EXTENSION_DIR") {
        let p = PathBuf::from(custom);
        if p.is_dir() {
            return Some(p);
        }
    }

    // Next to the running binary: ./extensions
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let beside = parent.join("extensions");
            if beside.is_dir() {
                return Some(beside);
            }
        }
    }

    // CWD (useful for `cargo run` / Electron from repo root)
    if let Ok(cwd) = env::current_dir() {
        let beside = cwd.join("extensions");
        if beside.is_dir() {
            return Some(beside);
        }
    }

    // Dev fallback: versioned third_party tree (still LOAD-from-file, no INSTALL)
    if let Ok(cwd) = env::current_dir() {
        let versioned = cwd
            .join("third_party/duckdb-extensions")
            .join(format!("v{}", env!("CARGO_PKG_VERSION"))); // unlikely match — scan below
        let _ = versioned;
        let root = cwd.join("third_party/duckdb-extensions");
        if root.is_dir() {
            // pick first */<platform> that contains httpfs or postgres_scanner
            let platform = duckdb_platform();
            if let Ok(entries) = std::fs::read_dir(&root) {
                for ent in entries.flatten() {
                    let candidate = ent.path().join(&platform);
                    if candidate.join("httpfs.duckdb_extension").is_file()
                        || candidate
                            .join("postgres_scanner.duckdb_extension")
                            .is_file()
                    {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    // Relative to this crate (cargo test)
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for candidate in [manifest.join("../../extensions")] {
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    None
}

fn find_in_dir(dir: &Path, files: &[&str]) -> Option<PathBuf> {
    for file in files {
        let p = dir.join(file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// LOAD from an absolute path only — never INSTALL / never hit the CDN.
fn load_from_path(conn: &Connection, path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("LOAD '{path_str}';"))
        .map_err(|e| format!("LOAD '{}' failed: {e}", path.display()))
}

fn load_spec(conn: &Connection, spec: &ExtSpec) -> Result<(), String> {
    let dir = resolve_extensions_dir().ok_or_else(|| {
        format!(
            "No `extensions/` folder next to the app (need {}).\n\
             Ship folder:\n\
               <app>/extensions/{}\n\
             Or set DWH_EXTENSIONS_DIR. Fetch once: scripts/fetch-duckdb-extensions.sh",
            spec.load_name,
            spec.files[0]
        )
    })?;

    let path = find_in_dir(&dir, spec.files).ok_or_else(|| {
        format!(
            "Extension `{}` not found in {}.\n\
             Expected one of: {}\n\
             Run: scripts/fetch-duckdb-extensions.sh",
            spec.load_name,
            dir.display(),
            spec.files.join(", ")
        )
    })?;

    load_from_path(conn, &path)
}

pub fn load_postgres_extension(conn: &Connection) -> Result<(), String> {
    load_spec(conn, &POSTGRES)
}

pub fn load_httpfs_extension(conn: &Connection) -> Result<(), String> {
    load_spec(conn, &HTTPFS)
}

pub fn load_aws_extension(conn: &Connection) -> Result<(), String> {
    load_spec(conn, &AWS)
}

/// Best-effort spatial: LOAD from sidecar only. Ok(false) = file not shipped (not an error).
pub fn try_load_spatial_extension(conn: &Connection) -> Result<bool, String> {
    let Some(dir) = resolve_extensions_dir() else {
        return Ok(false);
    };
    let Some(path) = find_in_dir(&dir, SPATIAL.files) else {
        return Ok(false);
    };
    load_from_path(conn, &path)?;
    Ok(true)
}

pub fn path_needs_httpfs(path: &str) -> bool {
    let p = path.trim().to_ascii_lowercase();
    p.starts_with("s3://")
        || p.starts_with("s3a://")
        || p.starts_with("http://")
        || p.starts_with("https://")
        || p.starts_with("hf://")
}

pub fn parquet_available() -> bool {
    true
}

/// Human-readable location used for logs / UI.
pub fn extensions_dir_display() -> String {
    resolve_extensions_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "<missing extensions/>".into())
}

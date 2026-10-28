//! Resolve a local `dbt` binary and run offline `dbt parse` (no warehouse).

use std::path::{Path, PathBuf};
use std::process::Command;

const LOG_TRUNCATE: usize = 8_192;

/// Outcome of `dbt parse` (files are already on disk regardless).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbtParseOutcome {
    pub ok: bool,
    pub log: String,
}

/// Candidate locations for a managed venv next to the Tauri crate / app.
pub fn default_dbt_venv_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Dev: repo `src-tauri/dbt-venv` (from dwh-pipeline crate or cwd).
    let pipeline_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    out.push(
        pipeline_manifest
            .join("../../src-tauri/dbt-venv/bin/dbt")
            .canonicalize()
            .unwrap_or_else(|_| {
                pipeline_manifest.join("../../src-tauri/dbt-venv/bin/dbt")
            }),
    );
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("src-tauri/dbt-venv/bin/dbt"));
        out.push(cwd.join("dbt-venv/bin/dbt"));
    }
    out
}

/// Prefer an executable at `extra` paths, then default venv candidates, then `dbt` on PATH.
pub fn resolve_dbt_bin(extra: &[PathBuf]) -> Option<PathBuf> {
    for p in extra.iter().chain(default_dbt_venv_candidates().iter()) {
        if is_executable(p) {
            return Some(p.clone());
        }
    }
    which_dbt()
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
        && std::fs::metadata(path)
            .map(|m| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    m.permissions().mode() & 0o111 != 0
                }
                #[cfg(not(unix))]
                {
                    let _ = m;
                    true
                }
            })
            .unwrap_or(false)
}

fn which_dbt() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("dbt");
        if is_executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let bat = dir.join("dbt.exe");
            if is_executable(&bat) {
                return Some(bat);
            }
        }
    }
    None
}

fn truncate_log(s: &str) -> String {
    if s.len() <= LOG_TRUNCATE {
        return s.to_string();
    }
    let mut cut = LOG_TRUNCATE;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…\n[log truncated]", &s[..cut])
}

fn run_dbt_subcommand(
    project_root: &str,
    dbt_bin: Option<&Path>,
    subcommand: &str,
    missing_hint: &str,
) -> DbtParseOutcome {
    let root = Path::new(project_root);
    if !root.is_dir() {
        return DbtParseOutcome {
            ok: false,
            log: format!("dbt {subcommand}: not a directory: {project_root}"),
        };
    }

    let bin = match dbt_bin {
        Some(p) => p.to_path_buf(),
        None => match resolve_dbt_bin(&[]) {
            Some(p) => p,
            None => {
                return DbtParseOutcome {
                    ok: false,
                    log: missing_hint.into(),
                };
            }
        },
    };

    // `current_dir` = project root so DuckDB `path: 'local.duckdb'` lands next to dbt_project.yml
    // (dbt-duckdb resolves relative paths against process cwd, not --project-dir).
    let output = Command::new(&bin)
        .current_dir(root)
        .args([
            subcommand,
            "--no-partial-parse",
            "--project-dir",
            ".",
            "--profiles-dir",
            ".",
        ])
        .output();

    match output {
        Ok(out) => {
            let mut log = String::new();
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stdout.trim().is_empty() {
                log.push_str(&stdout);
            }
            if !stderr.trim().is_empty() {
                if !log.is_empty() {
                    log.push('\n');
                }
                log.push_str(&stderr);
            }
            if log.trim().is_empty() {
                log = if out.status.success() {
                    format!("dbt {subcommand}: ok")
                } else {
                    format!("dbt {subcommand} failed (exit {:?})", out.status.code())
                };
            }
            DbtParseOutcome {
                ok: out.status.success(),
                log: truncate_log(&log),
            }
        }
        Err(e) => DbtParseOutcome {
            ok: false,
            log: format!("failed to run {}: {e}", bin.display()),
        },
    }
}

/// Run `dbt parse --no-partial-parse` with project + profiles in `project_root`.
/// Soft-fails when `dbt` is missing (ok=false, install hint in log).
pub fn dbt_parse(project_root: &str, dbt_bin: Option<&Path>) -> DbtParseOutcome {
    run_dbt_subcommand(
        project_root,
        dbt_bin,
        "parse",
        "dbt not found. Install with ./scripts/fetch-dbt-venv.sh \
or `pip install 'dbt-core>=1.7,<2' dbt-duckdb`, then ensure `dbt` is on PATH.",
    )
}

/// Run `dbt run` against the generated project (needs warehouse reachable via profiles).
/// Soft-fails when `dbt` is missing. Distinct from [`dbt_parse`] (author gate only).
pub fn dbt_run(project_root: &str, dbt_bin: Option<&Path>) -> DbtParseOutcome {
    run_dbt_subcommand(
        project_root,
        dbt_bin,
        "run",
        "dbt not found (needed for e2e `dbt run`). Install with ./scripts/fetch-dbt-venv.sh \
or `pip install 'dbt-core>=1.7,<2' dbt-duckdb`.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{QueryDef, TransformationStep, Workspace};
    use crate::producers::{DbtProducer, DbtTarget, OutputProducer};
    use crate::dialect::WarehouseDialect;
    use std::env::temp_dir;
    use std::fs::remove_dir_all;

    #[test]
    fn truncate_keeps_short() {
        assert_eq!(truncate_log("hi"), "hi");
    }

    #[test]
    fn missing_project_dir_fails() {
        let outcome = dbt_parse("/nonexistent/dbt/project/root", None);
        assert!(!outcome.ok);
        assert!(!outcome.log.is_empty());
    }

    #[test]
    fn export_sales_like_parses_when_dbt_available() {
        let Some(bin) = resolve_dbt_bin(&[]) else {
            eprintln!("skip: dbt not installed (run ./scripts/fetch-dbt-venv.sh)");
            return;
        };

        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let sample = fixtures.join("sample.csv");
        let dim = fixtures.join("dim_region.csv");
        if !sample.is_file() || !dim.is_file() {
            eprintln!("skip: fixtures missing");
            return;
        }

        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "dim_region".into(),
                    name: "dim_region".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "sales".into(),
                    name: "sales".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: sample.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "joined".into(),
                    name: "joined".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "sales".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim_region".into(),
                            join_type: crate::model::JoinType::Inner,
                            left_on: vec!["region".into()],
                            right_on: vec!["region".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "joined".into(),
        };

        let out = temp_dir().join(format!("dwh_dbt_parse_{}", std::process::id()));
        let _ = remove_dir_all(&out);
        let path = DbtProducer
            .produce(
                "parse_demo",
                &ws,
                out.to_str().unwrap(),
                DbtTarget::V1,
                WarehouseDialect::Duckdb,
            )
            .expect("produce");
        let outcome = dbt_parse(&path, Some(&bin));
        assert!(
            outcome.ok,
            "dbt parse failed:\n{}",
            outcome.log
        );
        let _ = remove_dir_all(&out);
    }
}

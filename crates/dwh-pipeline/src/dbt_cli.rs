//! Resolve a local `dbt` binary and run offline `dbt parse` (no warehouse).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const LOG_TRUNCATE: usize = 8_192;

/// Outcome of `dbt parse` (files are already on disk regardless).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbtParseOutcome {
    pub ok: bool,
    pub log: String,
}

/// Candidate locations for a managed venv next to the app / repo.
pub fn default_dbt_venv_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let pipeline_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    out.push(
        pipeline_manifest
            .join("../../dbt-venv/bin/dbt")
            .canonicalize()
            .unwrap_or_else(|_| pipeline_manifest.join("../../dbt-venv/bin/dbt")),
    );
    if let Ok(cwd) = std::env::current_dir() {
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

/// profiles.yml uses `path: 'local.duckdb'`. A tiny/non-DuckDB file (e.g. accidental
/// text write) makes every `dbt build` fail with "not a valid DuckDB database".
fn scrub_invalid_working_duckdb(project_root: &Path) {
    let path = project_root.join("local.duckdb");
    if !path.is_file() {
        return;
    }
    let ok = std::fs::File::open(&path)
        .ok()
        .and_then(|mut f| {
            use std::io::Read;
            let mut buf = [0u8; 16];
            let n = f.read(&mut buf).ok()?;
            // Real DuckDB files are binary and typically ≥ kilobytes; reject tiny / ASCII stubs.
            if n < 16 {
                return Some(false);
            }
            let meta = std::fs::metadata(&path).ok()?;
            if meta.len() < 4096 {
                return Some(false);
            }
            // Reject obvious text (printable ASCII start).
            if buf.iter().take(n).all(|b| b.is_ascii_graphic() || b.is_ascii_whitespace()) {
                return Some(false);
            }
            Some(true)
        })
        .unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(project_root.join("local.duckdb.wal"));
    }
}

fn run_dbt_subcommand(
    project_root: &str,
    dbt_bin: Option<&Path>,
    subcommand: &str,
    missing_hint: &str,
    extra_env: &HashMap<String, String>,
) -> DbtParseOutcome {
    let root = Path::new(project_root);
    if !root.is_dir() {
        return DbtParseOutcome {
            ok: false,
            log: format!("dbt {subcommand}: not a directory: {project_root}"),
        };
    }

    // Only for commands that open the working DB (not parse-only).
    if matches!(subcommand, "run" | "build" | "seed" | "test" | "compile") {
        scrub_invalid_working_duckdb(root);
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
    let mut cmd = Command::new(&bin);
    cmd.current_dir(root).args([
        subcommand,
        "--no-partial-parse",
        "--project-dir",
        ".",
        "--profiles-dir",
        ".",
    ]);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let output = cmd.output();

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

/// Env vars for generated `profiles.yml` (`DWH_PG_DSN` / `DWH_PG_PASSWORD`).
/// Prefer `preferred_connection_id` (destination), else first Postgres connection.
pub fn dbt_env_from_connections(
    connections: &[crate::connection::ConnectionDef],
    preferred_connection_id: Option<&str>,
) -> HashMap<String, String> {
    use crate::connection::ConnectionKind;
    let preferred = preferred_connection_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|id| connections.iter().find(|c| c.id == id));
    let conn = preferred.or_else(|| {
        connections
            .iter()
            .find(|c| c.kind == ConnectionKind::Postgres)
    });
    let mut env = HashMap::new();
    if let Some(dsn) = conn.and_then(|c| c.postgres_dsn()).map(str::trim).filter(|s| !s.is_empty())
    {
        env.insert("DWH_PG_DSN".into(), dsn.to_string());
        if let Some(pw) = password_from_postgres_dsn(dsn) {
            env.insert("DWH_PG_PASSWORD".into(), pw);
        }
    }
    env
}

/// Best-effort `user:password@` extract from a postgres URI (no full URL crate).
fn password_from_postgres_dsn(dsn: &str) -> Option<String> {
    let rest = dsn
        .strip_prefix("postgresql://")
        .or_else(|| dsn.strip_prefix("postgres://"))?;
    let creds = rest.split('@').next()?;
    let pass = creds.split_once(':')?.1;
    if pass.is_empty() {
        None
    } else {
        Some(pass.to_string())
    }
}

/// Run `dbt parse --no-partial-parse` with project + profiles in `project_root`.
/// Soft-fails when `dbt` is missing (ok=false, install hint in log).
pub fn dbt_parse(project_root: &str, dbt_bin: Option<&Path>) -> DbtParseOutcome {
    dbt_parse_with_env(project_root, dbt_bin, &HashMap::new())
}

/// Like [`dbt_parse`], with extra process env (e.g. `DWH_PG_DSN` from destination connection).
pub fn dbt_parse_with_env(
    project_root: &str,
    dbt_bin: Option<&Path>,
    extra_env: &HashMap<String, String>,
) -> DbtParseOutcome {
    run_dbt_subcommand(
        project_root,
        dbt_bin,
        "parse",
        "dbt not found. Install with ./scripts/fetch-dbt-venv.sh \
or `pip install 'dbt-core>=1.7,<2' dbt-duckdb`, then ensure `dbt` is on PATH.",
        extra_env,
    )
}

/// Run `dbt run` against the generated project (needs warehouse reachable via profiles).
/// Soft-fails when `dbt` is missing. Distinct from [`dbt_parse`] (author gate only).
/// Prefer [`dbt_build`] when the project has seeds (`ref('map_…')` etc.).
pub fn dbt_run(project_root: &str, dbt_bin: Option<&Path>) -> DbtParseOutcome {
    dbt_run_with_env(project_root, dbt_bin, &HashMap::new())
}

/// Like [`dbt_run`], with extra process env from the app destination connection.
pub fn dbt_run_with_env(
    project_root: &str,
    dbt_bin: Option<&Path>,
    extra_env: &HashMap<String, String>,
) -> DbtParseOutcome {
    run_dbt_subcommand(
        project_root,
        dbt_bin,
        "run",
        "dbt not found (needed for e2e `dbt run`). Install with ./scripts/fetch-dbt-venv.sh \
or `pip install 'dbt-core>=1.7,<2' dbt-duckdb`.",
        extra_env,
    )
}

/// `dbt build` = seed + run (+ tests). Required when models `ref()` KeyMap seeds.
pub fn dbt_build(project_root: &str, dbt_bin: Option<&Path>) -> DbtParseOutcome {
    dbt_build_with_env(project_root, dbt_bin, &HashMap::new())
}

/// Like [`dbt_build`], with destination connection env (`DWH_PG_DSN`, …).
pub fn dbt_build_with_env(
    project_root: &str,
    dbt_bin: Option<&Path>,
    extra_env: &HashMap<String, String>,
) -> DbtParseOutcome {
    run_dbt_subcommand(
        project_root,
        dbt_bin,
        "build",
        "dbt not found (needed for Build export). Install with ./scripts/fetch-dbt-venv.sh \
or `pip install 'dbt-core>=1.7,<2' dbt-duckdb`.",
        extra_env,
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
    fn scrub_removes_tiny_text_stub_duckdb() {
        let dir = temp_dir().join(format!("dwh_scrub_{}", std::process::id()));
        let _ = remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local.duckdb");
        std::fs::write(&path, b"d\n").unwrap();
        scrub_invalid_working_duckdb(&dir);
        assert!(!path.exists(), "tiny text stub must be removed");
        let _ = remove_dir_all(&dir);
    }

    #[test]
    fn env_from_preferred_postgres_connection() {
        use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams};
        let conns = vec![
            ConnectionDef {
                id: "other".into(),
                name: "other".into(),
                kind: ConnectionKind::Postgres,
                postgres: Some(PostgresParams {
                    connection_string: "postgresql://a:wrong@h/db".into(),
                }),
                s3: None,
                duckdb: None,
            },
            ConnectionDef {
                id: "dest".into(),
                name: "dest".into(),
                kind: ConnectionKind::Postgres,
                postgres: Some(PostgresParams {
                    connection_string: "postgresql://u:s3cret@host:5432/dwh".into(),
                }),
                s3: None,
                duckdb: None,
            },
        ];
        let env = dbt_env_from_connections(&conns, Some("dest"));
        assert_eq!(
            env.get("DWH_PG_DSN").map(String::as_str),
            Some("postgresql://u:s3cret@host:5432/dwh")
        );
        assert_eq!(
            env.get("DWH_PG_PASSWORD").map(String::as_str),
            Some("s3cret")
        );
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
            key_maps: vec![],
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

    /// Behavioral: nested seeds column_types keep "001" as varchar through dbt seed.
    #[test]
    fn leading_zero_seed_survives_dbt_build() {
        use crate::model::{KeyMapDef, KeyMapEntry};
        use crate::producers::dbt::build_export_plan;
        use std::collections::HashMap;
        use std::fs;
        use std::process::Command;

        let Some(bin) = resolve_dbt_bin(&[]) else {
            panic!("dbt required for leading_zero_seed_survives_dbt_build — run ./scripts/fetch-dbt-venv.sh");
        };

        let mut map = KeyMapDef::new("codes", "codes");
        map.entries = vec![
            KeyMapEntry {
                from: "001".into(),
                to: "online".into(),
                ..Default::default()
            },
            KeyMapEntry {
                from: "1".into(),
                to: "offline".into(),
                ..Default::default()
            },
        ];
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "codes_out".into(),
                steps: vec![
                    TransformationStep::LoadCsv {
                        path: "dummy.csv".into(),
                    },
                    TransformationStep::ApplyKeyMap {
                        column: "c".into(),
                        map_id: map.id.clone(),
                        entries: map.entries.clone(),
                    },
                ],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![map],
        };
        let plan = build_export_plan(
            "leadzero",
            &ws,
            DbtTarget::V1,
            WarehouseDialect::Duckdb,
            &HashMap::new(),
        )
        .unwrap();
        assert!(
            plan["dbt_project.yml"].contains("seeds:\n  leadzero:\n    map_"),
            "{}",
            plan["dbt_project.yml"]
        );

        let out = temp_dir().join(format!("dwh_leadzero_{}", std::process::id()));
        let _ = remove_dir_all(&out);
        let root = out.join("leadzero");
        fs::create_dir_all(&root).unwrap();
        for (rel, body) in &plan {
            let p = root.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, body).unwrap();
        }
        // Tiny csv so ApplyKeyMap model can parse; we only need seed for this check.
        fs::write(root.join("dummy.csv"), "c\n001\n").ok();

        let seed = Command::new(&bin)
            .current_dir(&root)
            .args([
                "seed",
                "--no-partial-parse",
                "--project-dir",
                ".",
                "--profiles-dir",
                ".",
            ])
            .output()
            .expect("run dbt seed");
        let log = format!(
            "{}{}",
            String::from_utf8_lossy(&seed.stdout),
            String::from_utf8_lossy(&seed.stderr)
        );
        assert!(seed.status.success(), "dbt seed failed:\n{log}");

        let duck_path = root.join("local.duckdb");
        // Use the same venv as `dbt` — system python3 often lacks the duckdb package.
        let py_bin = bin
            .parent()
            .map(|d| d.join("python3"))
            .filter(|p| p.is_file())
            .or_else(|| {
                bin.parent()
                    .map(|d| d.join("python"))
                    .filter(|p| p.is_file())
            })
            .unwrap_or_else(|| PathBuf::from("python3"));
        let py = format!(
            r#"import duckdb
con=duckdb.connect({duck_path:?})
rows=con.execute('select \"from\", \"to\", typeof(\"from\") from main.map_codes order by 1').fetchall()
print(rows)
assert any(r[0]=='001' and r[1]=='online' and 'VARCHAR' in r[2] for r in rows), rows
assert any(r[0]=='1' for r in rows), rows
"#
        );
        let check = Command::new(&py_bin)
            .arg("-c")
            .arg(&py)
            .output()
            .unwrap_or_else(|e| panic!("run {py_bin:?}: {e}"));
        assert!(
            check.status.success(),
            "leading-zero check failed (python={py_bin:?}):\n{}{}",
            String::from_utf8_lossy(&check.stdout),
            String::from_utf8_lossy(&check.stderr)
        );
        let _ = remove_dir_all(&out);
    }
}

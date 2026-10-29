use crate::extensions::{
    extensions_dir_display, load_aws_extension, load_httpfs_extension, load_postgres_extension,
    path_needs_httpfs, try_load_spatial_extension,
};
use crate::postgres_catalog::ensure_pg_attached;
use crate::secrets::apply_s3_connections;
use duckdb::{Config, Connection};
use dwh_pipeline::{ConnectionDef, ConnectionKind, TransformationStep, Workspace};
use std::collections::HashSet;
use std::sync::Mutex;

pub struct DbSession {
    conn: Mutex<Connection>,
    postgres_ready: Mutex<bool>,
    httpfs_ready: Mutex<bool>,
    postgres_error: Mutex<Option<String>>,
    httpfs_error: Mutex<Option<String>>,
}

impl DbSession {
    pub fn new() -> Result<Self, String> {
        // duckdb-rs 1.20000 bundles DuckDB v2.0.0 (source_id d54cbbe3df). Official CDN
        // extensions are tagged library_version `v2.0.0`; LOAD without this flag rejects
        // them as a source_id mismatch. Artifacts are still DuckDB-signed core extensions.
        let config = Config::default()
            .with("allow_extensions_metadata_mismatch", "true")
            .map_err(|e| e.to_string())?;
        let conn = Connection::open_in_memory_with_flags(config).map_err(|e| e.to_string())?;
        let session = Self {
            conn: Mutex::new(conn),
            postgres_ready: Mutex::new(false),
            httpfs_ready: Mutex::new(false),
            postgres_error: Mutex::new(None),
            httpfs_error: Mutex::new(None),
        };
        session.load_extensions();
        Ok(session)
    }

    fn load_extensions(&self) {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return,
        };

        eprintln!(
            "[dwh-rs-query] DuckDB; extensions dir: {}",
            extensions_dir_display()
        );

        match load_postgres_extension(&conn) {
            Ok(()) => {
                *self.postgres_ready.lock().unwrap_or_else(|e| e.into_inner()) = true;
                *self.postgres_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(e) => {
                eprintln!("[dwh-rs-query] postgres extension (offline-first): {e}");
                *self.postgres_ready.lock().unwrap_or_else(|e| e.into_inner()) = false;
                *self.postgres_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
            }
        }

        match load_httpfs_extension(&conn) {
            Ok(()) => {
                *self.httpfs_ready.lock().unwrap_or_else(|e| e.into_inner()) = true;
                *self.httpfs_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if let Err(e) = load_aws_extension(&conn) {
                    eprintln!("[dwh-rs-query] aws extension (optional, offline): {e}");
                }
            }
            Err(e) => {
                eprintln!("[dwh-rs-query] httpfs extension (offline-first): {e}");
                *self.httpfs_ready.lock().unwrap_or_else(|e| e.into_inner()) = false;
                *self.httpfs_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
            }
        }

        // spatial: optional sidecar only — never bare LOAD (that hits ~/.duckdb / CDN).
        match try_load_spatial_extension(&conn) {
            Ok(true) => {}
            Ok(false) => {} // not shipped in extensions/ — expected
            Err(e) => eprintln!("[dwh-rs-query] spatial extension (optional): {e}"),
        }
    }

    pub fn postgres_ready(&self) -> bool {
        self.postgres_ready
            .lock()
            .map(|g| *g)
            .unwrap_or(false)
    }

    pub fn httpfs_ready(&self) -> bool {
        self.httpfs_ready.lock().map(|g| *g).unwrap_or(false)
    }

    pub fn ensure_postgres(&self) -> Result<(), String> {
        if self.postgres_ready() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match load_postgres_extension(&conn) {
            Ok(()) => {
                drop(conn);
                *self.postgres_ready.lock().unwrap_or_else(|e| e.into_inner()) = true;
                *self.postgres_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                Ok(())
            }
            Err(e) => {
                *self.postgres_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
                Err(e)
            }
        }
    }

    pub fn ensure_httpfs(&self) -> Result<(), String> {
        if self.httpfs_ready() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match load_httpfs_extension(&conn) {
            Ok(()) => {
                let _ = load_aws_extension(&conn);
                drop(conn);
                *self.httpfs_ready.lock().unwrap_or_else(|e| e.into_inner()) = true;
                *self.httpfs_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                Ok(())
            }
            Err(e) => {
                *self.httpfs_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
                Err(e)
            }
        }
    }

    /// Extensions + secrets + Postgres ATTACH for a workspace run (ADR-0012).
    pub fn prepare_workspace(
        &self,
        workspace: &Workspace,
        connections: &[ConnectionDef],
    ) -> Result<Workspace, String> {
        let resolved = workspace.resolve_postgres_dsns(connections)?;
        if resolved.uses_postgres() {
            self.ensure_postgres()?;
            // DuckDB 2.0: LoadPostgres SQL uses alias.schema.table after ATTACH (not postgres_scan).
            let mut dsns = HashSet::new();
            for q in &resolved.queries {
                for s in &q.steps {
                    if let TransformationStep::LoadPostgres {
                        connection_string, ..
                    } = s
                    {
                        let dsn = connection_string.trim();
                        if !dsn.is_empty() {
                            dsns.insert(dsn.to_string());
                        }
                    }
                }
            }
            self.with_conn(|conn| {
                for dsn in &dsns {
                    ensure_pg_attached(conn, dsn)?;
                }
                Ok(())
            })?;
        }
        // External DuckDB sources: ATTACH read-only (working DB stays in-memory / separate).
        {
            use dwh_pipeline::{duckdb_file_attach_alias, escape_sql_string};
            let mut paths = HashSet::new();
            for q in &resolved.queries {
                for s in &q.steps {
                    if let TransformationStep::LoadDuckdb { path, connection_id, .. } = s {
                        let p = if !path.trim().is_empty() {
                            path.trim().to_string()
                        } else if let Some(cid) = connection_id {
                            connections
                                .iter()
                                .find(|c| c.id == *cid)
                                .and_then(|c| c.duckdb_path())
                                .unwrap_or("")
                                .to_string()
                        } else {
                            String::new()
                        };
                        if !p.is_empty() {
                            paths.insert(p);
                        }
                    }
                }
            }
            if !paths.is_empty() {
                self.with_conn(|conn| {
                    for p in &paths {
                        let alias = duckdb_file_attach_alias(p);
                        let sql = format!(
                            "ATTACH IF NOT EXISTS '{}' AS {alias} (READ_ONLY);",
                            escape_sql_string(p)
                        );
                        conn.execute_batch(&sql).map_err(|e| {
                            format!("ATTACH duckdb source {p}: {e}")
                        })?;
                    }
                    Ok(())
                })?;
            }
        }
        if workspace_needs_httpfs(&resolved, connections) {
            self.ensure_httpfs()?;
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            apply_s3_connections(&conn, connections, Some(&resolved))?;
        }
        Ok(resolved)
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&conn)
    }
}

fn workspace_needs_httpfs(workspace: &Workspace, connections: &[ConnectionDef]) -> bool {
    let refs_s3 = workspace.referenced_connection_ids().iter().any(|id| {
        connections
            .iter()
            .any(|c| &c.id == id && matches!(c.kind, ConnectionKind::S3))
    });
    if refs_s3 {
        return true;
    }
    workspace.queries.iter().any(|q| {
        q.steps.iter().any(|s| match s {
            TransformationStep::LoadParquet { path, .. }
            | TransformationStep::LoadCsv { path } => path_needs_httpfs(path),
            TransformationStep::SqlModel { raw_sql }
            | TransformationStep::CustomSql { raw_sql } => {
                let lower = raw_sql.to_ascii_lowercase();
                lower.contains("s3://")
                    || lower.contains("s3a://")
                    || lower.contains("http://")
                    || lower.contains("https://")
            }
            _ => false,
        })
    })
}

use duckdb::Connection;
use std::sync::Mutex;

pub struct DbSession {
    conn: Mutex<Connection>,
    /// True if DuckDB `postgres` extension loaded successfully.
    postgres_ready: Mutex<bool>,
}

impl DbSession {
    pub fn new() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let session = Self {
            conn: Mutex::new(conn),
            postgres_ready: Mutex::new(false),
        };
        session.load_extensions();
        Ok(session)
    }

    fn load_extensions(&self) {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return,
        };

        // postgres is a required product capability — record success/failure.
        match conn.execute_batch("INSTALL postgres; LOAD postgres;") {
            Ok(()) => {
                if let Ok(mut flag) = self.postgres_ready.lock() {
                    *flag = true;
                }
            }
            Err(e) => {
                eprintln!(
                    "[dwh-rs-query] REQUIRED extension `postgres` not loaded: {e}\n\
                     CSV/Parquet preview may still work; LoadPostgres will fail until fixed."
                );
                if let Ok(mut flag) = self.postgres_ready.lock() {
                    *flag = false;
                }
            }
        }

        // spatial remains best-effort
        if let Err(e) = conn.execute_batch("INSTALL spatial; LOAD spatial;") {
            eprintln!("[dwh-rs-query] extension `spatial` not loaded (best-effort): {e}");
        }
    }

    pub fn postgres_ready(&self) -> bool {
        self.postgres_ready
            .lock()
            .map(|g| *g)
            .unwrap_or(false)
    }

    /// Call before executing SQL that uses postgres_scan / LoadPostgres.
    pub fn ensure_postgres(&self) -> Result<(), String> {
        if self.postgres_ready() {
            return Ok(());
        }
        // Retry once (INSTALL may succeed after network/cache becomes available).
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            if conn
                .execute_batch("INSTALL postgres; LOAD postgres;")
                .is_ok()
            {
                drop(conn);
                if let Ok(mut flag) = self.postgres_ready.lock() {
                    *flag = true;
                }
                return Ok(());
            }
        }
        Err(
            "PostgreSQL support is required but the DuckDB `postgres` extension is unavailable. \
             Check network for INSTALL, DuckDB version, and that lib/extension paths are writable. \
             CSV/Parquet queries can still run."
                .into(),
        )
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&conn)
    }
}

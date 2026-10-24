use duckdb::Connection;
use std::sync::Mutex;

pub struct DbSession {
    conn: Mutex<Connection>,
}

impl DbSession {
    pub fn new() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let session = Self {
            conn: Mutex::new(conn),
        };
        session.load_extensions_best_effort();
        Ok(session)
    }

    fn load_extensions_best_effort(&self) {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        for ext in ["postgres", "spatial"] {
            if let Err(e) = conn.execute_batch(&format!("INSTALL {ext}; LOAD {ext};")) {
                eprintln!("[dwh-rs-query] extension `{ext}` not loaded: {e}");
            }
        }
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&conn)
    }
}

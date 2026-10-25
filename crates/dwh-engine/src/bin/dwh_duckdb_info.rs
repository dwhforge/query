//! Print DuckDB version tag (e.g. v1.3.2) for extension fetch scripts.
use dwh_engine::{duckdb_platform, duckdb_version_tag, DbSession};

fn main() {
    match DbSession::new() {
        Ok(db) => {
            let _ = db.with_conn(|conn| {
                match duckdb_version_tag(conn) {
                    Ok(v) => print!("{v}"),
                    Err(e) => {
                        eprintln!("version error: {e}");
                        std::process::exit(1);
                    }
                }
                Ok(())
            });
            eprintln!(" platform={}", duckdb_platform());
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

//! DuckDB 2.0+ Postgres access: ATTACH + qualified relation (not `postgres_scan`).

use crate::sql_escape::quote_ident;

/// Stable DuckDB ATTACH alias for a Postgres DSN (opaque identifier).
pub fn postgres_attach_alias(conn_str: &str) -> String {
    attach_alias("dwh_pg", conn_str)
}

/// Stable alias for an attached DuckDB source file (read-only).
pub fn duckdb_file_attach_alias(path: &str) -> String {
    attach_alias("dwh_ddb", path)
}

fn attach_alias(prefix: &str, key: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}_{h:016x}")
}

/// `alias."schema"."table"` for use inside DuckDB SQL after ATTACH.
pub fn duckdb_postgres_relation(conn_str: &str, schema: &str, table: &str) -> String {
    let alias = postgres_attach_alias(conn_str);
    format!(
        "{alias}.{}.{}",
        quote_ident(schema),
        quote_ident(table)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_stable() {
        let a = postgres_attach_alias("postgresql://u:p@localhost/db");
        let b = postgres_attach_alias("postgresql://u:p@localhost/db");
        assert_eq!(a, b);
        assert!(a.starts_with("dwh_pg_"));
    }
}

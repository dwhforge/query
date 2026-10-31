use crate::sql_escape::escape_sql_string;

/// `read_parquet(...)` for a single file, a glob, or a directory.
///
/// - Single `*.parquet` file → plain `read_parquet('…')`.
/// - Glob → plain `read_parquet('glob')` (DuckDB auto-detects partitions when safe).
/// - Directory → `…/**/*.parquet`. With `hive_partitioning`, adds
///   `hive_partitioning = true` (Hive table roots from the Hive Parquet UI).
pub fn read_parquet_call(path: &str) -> String {
    read_parquet_call_opts(path, false)
}

pub fn read_parquet_call_opts(path: &str, hive_partitioning: bool) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "read_parquet('')".into();
    }
    let is_glob = trimmed.contains('*') || trimmed.contains('?');
    let bare = if is_glob {
        trimmed
    } else {
        trimmed.trim_end_matches(['/', '\\'])
    };
    let is_file = !is_glob && bare.to_ascii_lowercase().ends_with(".parquet");
    if is_file {
        return format!("read_parquet('{}')", escape_sql_string(bare));
    }
    let scan = if is_glob {
        bare.to_string()
    } else {
        format!("{bare}/**/*.parquet")
    };
    if hive_partitioning {
        format!(
            "read_parquet('{}', hive_partitioning = true)",
            escape_sql_string(&scan)
        )
    } else {
        format!("read_parquet('{}')", escape_sql_string(&scan))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_file_is_unchanged() {
        assert_eq!(
            read_parquet_call("/data/sales.parquet"),
            "read_parquet('/data/sales.parquet')"
        );
    }

    #[test]
    fn plain_glob_has_no_forced_hive() {
        assert_eq!(
            read_parquet_call("/data/sales/*.parquet"),
            "read_parquet('/data/sales/*.parquet')"
        );
        assert_eq!(
            read_parquet_call_opts("/data/sales/*.parquet", false),
            "read_parquet('/data/sales/*.parquet')"
        );
    }

    #[test]
    fn directory_expands_glob() {
        assert_eq!(
            read_parquet_call("/data/hive/warehouse/sales"),
            "read_parquet('/data/hive/warehouse/sales/**/*.parquet')"
        );
    }

    #[test]
    fn hive_opt_in_enables_partitions() {
        assert_eq!(
            read_parquet_call_opts("/data/hive/warehouse/sales", true),
            "read_parquet('/data/hive/warehouse/sales/**/*.parquet', hive_partitioning = true)"
        );
        assert_eq!(
            read_parquet_call_opts("/data/hive/sales/**/*.parquet", true),
            "read_parquet('/data/hive/sales/**/*.parquet', hive_partitioning = true)"
        );
    }

    #[test]
    fn quotes_are_escaped() {
        assert_eq!(
            read_parquet_call_opts("/data/o'brien", true),
            "read_parquet('/data/o''brien/**/*.parquet', hive_partitioning = true)"
        );
    }
}

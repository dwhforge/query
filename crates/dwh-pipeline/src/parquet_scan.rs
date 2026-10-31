use crate::sql_escape::escape_sql_string;

/// `read_parquet(...)` for a single file, a glob, or a Hive table directory.
///
/// A directory path is expanded to `/**/*.parquet`. Hive partition folders
/// (`key=value`) become columns. A path that already ends in `.parquet` and
/// has no wildcard stays a single-file scan.
pub fn read_parquet_call(path: &str) -> String {
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
    format!(
        "read_parquet('{}', hive_partitioning = true)",
        escape_sql_string(&scan)
    )
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
        assert_eq!(
            read_parquet_call("/data/Sales.PARQUET/"),
            "read_parquet('/data/Sales.PARQUET')"
        );
    }

    #[test]
    fn hive_directory_globs_and_enables_partitions() {
        assert_eq!(
            read_parquet_call("/data/hive/warehouse/sales"),
            "read_parquet('/data/hive/warehouse/sales/**/*.parquet', hive_partitioning = true)"
        );
        assert_eq!(
            read_parquet_call("/data/hive/warehouse/sales/"),
            "read_parquet('/data/hive/warehouse/sales/**/*.parquet', hive_partitioning = true)"
        );
    }

    #[test]
    fn explicit_glob_is_kept() {
        assert_eq!(
            read_parquet_call("/data/hive/sales/**/*.parquet"),
            "read_parquet('/data/hive/sales/**/*.parquet', hive_partitioning = true)"
        );
    }

    #[test]
    fn quotes_are_escaped() {
        assert_eq!(
            read_parquet_call("/data/o'brien"),
            "read_parquet('/data/o''brien/**/*.parquet', hive_partitioning = true)"
        );
    }
}

//! DuckDB out-of-core defaults: memory_limit + temp_directory.
//!
//! Without a memory_limit DuckDB grows until the kernel OOM-kills the process.
//! With a limit, hash joins / aggregates spill to temp_directory instead.

use std::path::{Path, PathBuf};

/// Env override for `SET memory_limit=…` (e.g. `16GB`, `8192MB`).
pub const ENV_MEMORY: &str = "DWH_DUCKDB_MEMORY";
/// Env override for DuckDB spill directory.
pub const ENV_TEMP: &str = "DWH_DUCKDB_TEMP";

/// Fraction of system RAM reserved for DuckDB when env is unset.
const DEFAULT_RAM_FRACTION: f64 = 0.55;
const MIN_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
/// Fallback when RAM cannot be detected (non-Linux / no cgroup).
const FALLBACK_MEMORY: &str = "4GB";

/// Resolve memory_limit string for DuckDB.
pub fn resolve_memory_limit() -> String {
    if let Ok(raw) = std::env::var(ENV_MEMORY) {
        let t = raw.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    match available_ram_bytes() {
        Some(total) => {
            let capped = ((total as f64) * DEFAULT_RAM_FRACTION) as u64;
            let bytes = capped
                .max(MIN_MEMORY_BYTES.min(total.saturating_sub(256 * 1024 * 1024)))
                .min(total.saturating_sub(1024 * 1024 * 1024));
            format_memory_bytes(bytes.max(512 * 1024 * 1024))
        }
        None => FALLBACK_MEMORY.into(),
    }
}

/// Resolve and create the spill directory.
pub fn resolve_temp_directory() -> Result<PathBuf, String> {
    let path = if let Ok(raw) = std::env::var(ENV_TEMP) {
        let t = raw.trim();
        if t.is_empty() {
            default_temp_directory()?
        } else {
            PathBuf::from(t)
        }
    } else {
        default_temp_directory()?
    };
    std::fs::create_dir_all(&path).map_err(|e| {
        format!(
            "Cannot create DuckDB temp_directory {}: {e}",
            path.display()
        )
    })?;
    Ok(path)
}

fn default_temp_directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot resolve home directory for DuckDB temp".to_string())?;
    Ok(home.join(".dwhforge-query").join("duckdb-tmp"))
}

fn format_memory_bytes(bytes: u64) -> String {
    const GB: u64 = 1024 * 1024 * 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= GB && bytes % GB == 0 {
        format!("{}GB", bytes / GB)
    } else if bytes >= GB {
        // DuckDB accepts fractional GB poorly in some builds — prefer whole MB.
        format!("{}MB", (bytes / MB).max(1))
    } else {
        format!("{}MB", (bytes / MB).max(1))
    }
}

/// Prefer the tighter of host MemTotal and cgroup memory.max (containers).
fn available_ram_bytes() -> Option<u64> {
    let host = system_ram_bytes();
    let cgroup = cgroup_memory_limit_bytes();
    match (host, cgroup) {
        (Some(h), Some(c)) => Some(h.min(c)),
        (Some(h), None) => Some(h),
        (None, Some(c)) => Some(c),
        (None, None) => None,
    }
}

fn system_ram_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read_to_string("/proc/meminfo").ok()?;
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
                return Some(kb.saturating_mul(1024));
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// cgroup v2 `memory.max` or cgroup v1 `memory.limit_in_bytes`.
fn cgroup_memory_limit_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        const HUGE: u64 = 1u64 << 62; // treat "max" / host-sized limits as unset
        let candidates = [
            "/sys/fs/cgroup/memory.max",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        ];
        for path in candidates {
            let raw = match std::fs::read_to_string(path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let t = raw.trim();
            if t.is_empty() || t.eq_ignore_ascii_case("max") {
                continue;
            }
            if let Ok(n) = t.parse::<u64>() {
                if n > 0 && n < HUGE {
                    return Some(n);
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Apply resource settings on an open DuckDB connection.
pub fn apply_resource_settings(conn: &duckdb::Connection) -> Result<(String, PathBuf), String> {
    let memory = resolve_memory_limit();
    let temp = resolve_temp_directory()?;
    let temp_sql = escape_sql_path(&temp);
    let batch = format!(
        "SET memory_limit='{memory}';\n\
         SET temp_directory='{temp_sql}';\n\
         SET preserve_insertion_order=false;\n"
    );
    conn.execute_batch(&batch).map_err(|e| {
        format!(
            "DuckDB resource settings failed (memory_limit={memory}, temp={}): {e}",
            temp.display()
        )
    })?;
    eprintln!(
        "[dwh-rs-query] DuckDB memory_limit={memory} temp_directory={} (override via {ENV_MEMORY} / {ENV_TEMP})",
        temp.display()
    );
    Ok((memory, temp))
}

fn escape_sql_path(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

const OOM_PREFIX: &str = "DuckDB hit its memory_limit";
const CANCEL_MSG: &str = "Preview cancelled.";
const SPILL_PREFIX: &str = "DuckDB could not spill to temp_directory";

/// Rewrite DuckDB/engine errors into actionable UI copy (idempotent).
pub fn map_engine_error(err: &str) -> String {
    if err.starts_with(OOM_PREFIX) || err == CANCEL_MSG || err.starts_with(SPILL_PREFIX) {
        return err.to_string();
    }
    let lower = err.to_lowercase();
    if lower.contains("out of memory")
        || lower.contains("memory limit")
        || lower.contains("memory_limit")
        || lower.contains("could not allocate")
    {
        return format!(
            "{OOM_PREFIX} while computing preview (LIMIT applies only to the final rows; Join/GroupBy still scan full inputs). \
Raise {ENV_MEMORY} (e.g. 16GB), free disk under ~/.dwhforge-query/duckdb-tmp for spill, or close other apps. Detail: {err}"
        );
    }
    // Exact DuckDB interrupt markers only — do not match paths like /data/cancelled/...
    if lower.contains("interrupt error")
        || lower.contains("query interrupted")
        || lower.contains("interrupted")
        || lower.contains("query cancelled")
        || lower.contains("query canceled")
    {
        return CANCEL_MSG.into();
    }
    if lower.contains("temp_directory")
        || (lower.contains("cannot open file") && lower.contains("temp"))
    {
        return format!("{SPILL_PREFIX}. Free disk or set {ENV_TEMP}. Detail: {err}");
    }
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_round_gb() {
        assert_eq!(format_memory_bytes(8 * 1024 * 1024 * 1024), "8GB");
        assert_eq!(format_memory_bytes(1500 * 1024 * 1024), "1500MB");
    }

    #[test]
    fn env_memory_wins() {
        std::env::set_var(ENV_MEMORY, "4GB");
        assert_eq!(resolve_memory_limit(), "4GB");
        std::env::remove_var(ENV_MEMORY);
    }

    #[test]
    fn map_oom_mentions_env() {
        let m = map_engine_error("Out of Memory Error: failed to allocate");
        assert!(m.contains(ENV_MEMORY));
        assert!(m.contains("memory_limit"));
        // Idempotent — no double wrap.
        let again = map_engine_error(&m);
        assert_eq!(again, m);
    }

    #[test]
    fn map_cancel_does_not_match_path() {
        let m = map_engine_error("IO Error: No such file or directory: /data/cancelled/sales.parquet");
        assert!(!m.contains("Preview cancelled"));
        assert!(m.contains("/data/cancelled"));
    }

    #[test]
    fn map_interrupt_is_cancel() {
        assert_eq!(
            map_engine_error("INTERRUPT Error: Interrupted!"),
            CANCEL_MSG
        );
    }

    #[test]
    fn apply_settings_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dwh_duck_tmp_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var(ENV_TEMP, &dir);
        std::env::set_var(ENV_MEMORY, "2GB");
        let conn = duckdb::Connection::open_in_memory().unwrap();
        let (mem, temp) = apply_resource_settings(&conn).unwrap();
        assert_eq!(mem, "2GB");
        assert_eq!(temp, dir);
        let got_mem: String = conn
            .query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0))
            .unwrap();
        // DuckDB may rewrite `2GB` as decimal→binary (e.g. `1.8 GiB`).
        assert!(
            !got_mem.trim().is_empty(),
            "memory_limit should be set, got empty"
        );
        let got_temp: String = conn
            .query_row("SELECT current_setting('temp_directory')", [], |r| r.get(0))
            .unwrap();
        assert!(
            got_temp.contains("dwh_duck_tmp"),
            "unexpected temp_directory={got_temp}"
        );
        std::env::remove_var(ENV_TEMP);
        std::env::remove_var(ENV_MEMORY);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

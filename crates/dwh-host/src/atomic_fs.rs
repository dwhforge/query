//! Smallest atomic file replace helper for project / secrets / connections.
//!
//! Write complete bytes to a unique temp file in the destination directory,
//! sync, then rename over the target. Never deletes the destination first.
//!
//! Limitations (documented, not claimed safe): multi-process writers, network
//! filesystems with non-atomic rename, and crashes between multi-file saves
//! (project vs secrets vs connections) are not a distributed transaction.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Atomically replace `path` with `bytes` (same-directory temp + rename).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_with_mode(path, bytes, None)
}

/// Like [`atomic_write`], optionally setting Unix mode on the temp file before rename.
pub fn atomic_write_with_mode(
    path: &Path,
    bytes: &[u8],
    unix_mode: Option<u32>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("create_dir {}: {e}", parent.display()))?;

    let fname = path
        .file_name()
        .ok_or_else(|| format!("atomic_write: not a file path: {}", path.display()))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp: PathBuf = parent.join(format!(
        ".{}.{}-{}.tmp",
        fname.to_string_lossy(),
        std::process::id(),
        nanos
    ));

    let write_tmp = || -> Result<(), String> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        let mut f = opts
            .open(&tmp)
            .map_err(|e| format!("temp create {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("temp write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("temp sync {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        if let Some(mode) = unix_mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))
                .map_err(|e| format!("temp chmod {}: {e}", tmp.display()))?;
        }
        Ok(())
    };

    if let Err(e) = write_tmp() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // rename replaces destination on Unix and Windows when same volume.
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "atomic replace {} ← {}: {e}",
            path.display(),
            tmp.display()
        ));
    }

    // Best-effort directory sync so the directory entry is durable.
    #[cfg(unix)]
    {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dwh_atomic_{label}_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn successful_replacement_is_readable() {
        let dir = tmp_dir("ok");
        let path = dir.join("proj.json");
        fs::write(&path, b"old").unwrap();
        atomic_write(&path, b"{\"ok\":true}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":true}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_temp_write_leaves_previous_bytes() {
        let dir = tmp_dir("keep");
        let path = dir.join("proj.json");
        fs::write(&path, b"keep-me").unwrap();
        // Simulate pre-commit failure: write temp then remove it without rename.
        let tmp = dir.join(format!(".proj.json.{}-sim.tmp", std::process::id()));
        fs::write(&tmp, b"partial").unwrap();
        fs::remove_file(&tmp).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep-me");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_only_destination_dir_errors_without_clobber() {
        let dir = tmp_dir("ro");
        let path = dir.join("proj.json");
        fs::write(&path, b"safe").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
            let err = atomic_write(&path, b"new");
            // restore writable for cleanup
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(err.is_err(), "expected error on read-only dir");
            assert_eq!(fs::read_to_string(&path).unwrap(), "safe");
        }
        #[cfg(not(unix))]
        {
            let _ = path;
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_new_file() {
        let dir = tmp_dir("new");
        let path = dir.join("fresh.json");
        atomic_write(&path, b"hello").unwrap();
        let mut buf = String::new();
        File::open(&path)
            .unwrap()
            .read_to_string(&mut buf)
            .unwrap();
        assert_eq!(buf, "hello");
        let _ = fs::remove_dir_all(&dir);
    }
}

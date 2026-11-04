//! Smallest atomic file replace helper for project / secrets / connections.
//!
//! ## Guarantees
//! - **Atomic replacement:** the destination is never partially overwritten. A
//!   failure before `rename` leaves previous bytes intact; a successful
//!   [`AtomicWriteOutcome`] means the published path holds the new contents.
//! - **Confidentiality (Unix):** when `unix_mode` is set (secrets: `0o600`), the
//!   temp file is created with that mode **before** any bytes are written.
//! - **Mode preservation:** replacing an existing file keeps its prior Unix
//!   mode bits when `unix_mode` is `None` (project / connections).
//!
//! ## Not guaranteed
//! - Directory-entry durability after power loss: parent `sync_all` is
//!   **best-effort**. Failure is returned as
//!   [`AtomicWriteOutcome::PostCommitDirSync`] — **not** “old file kept”
//!   (rename already succeeded).
//! - Multi-process writers, network filesystems with non-atomic rename, and
//!   crashes between multi-file saves (project vs secrets vs connections) are
//!   not a distributed transaction.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Result after content has been published (or an error before publish).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AtomicWriteOutcome {
    /// Destination published; directory sync skipped or succeeded.
    Committed,
    /// Destination published, but parent directory sync failed (durability gap).
    PostCommitDirSync { message: String },
}

/// Test-only fault injection points on the production write path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicWriteFault {
    /// Fail after temp create, before any payload bytes.
    AfterCreate,
    /// Fail after a partial payload write (first byte only), before sync/rename.
    AfterPartialWrite,
    /// Fail after full write+sync, before rename.
    BeforeRename,
    /// Fail instead of rename (temp cleaned up; destination untouched).
    Rename,
}

#[cfg(test)]
thread_local! {
    static TEST_FAULT: std::cell::Cell<Option<AtomicWriteFault>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub fn set_test_fault(fault: Option<AtomicWriteFault>) {
    TEST_FAULT.with(|c| c.set(fault));
}

#[cfg(test)]
fn take_test_fault() -> Option<AtomicWriteFault> {
    TEST_FAULT.with(|c| c.take())
}

#[cfg(not(test))]
fn take_test_fault() -> Option<AtomicWriteFault> {
    None
}

/// Atomically replace `path` with `bytes` (same-directory temp + rename).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<AtomicWriteOutcome, String> {
    atomic_write_with_mode(path, bytes, None)
}

/// Like [`atomic_write`], with an explicit Unix create mode for the temp file.
///
/// - `Some(0o600)` — secrets: closed from the first byte.
/// - `None` — when replacing, copy the existing file's mode; new files use the
///   platform/umask default.
pub fn atomic_write_with_mode(
    path: &Path,
    bytes: &[u8],
    unix_mode: Option<u32>,
) -> Result<AtomicWriteOutcome, String> {
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

    #[cfg(unix)]
    let create_mode: Option<u32> = {
        use std::os::unix::fs::PermissionsExt;
        if let Some(m) = unix_mode {
            Some(m & 0o7777)
        } else if path.is_file() {
            fs::metadata(path)
                .ok()
                .map(|md| md.permissions().mode() & 0o7777)
        } else {
            None
        }
    };
    #[cfg(not(unix))]
    let create_mode: Option<u32> = unix_mode;

    let fault = take_test_fault();

    let write_tmp = || -> Result<(), String> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if let Some(mode) = create_mode {
                opts.mode(mode);
            }
        }
        let mut f = opts
            .open(&tmp)
            .map_err(|e| format!("temp create {}: {e}", tmp.display()))?;

        if fault == Some(AtomicWriteFault::AfterCreate) {
            #[cfg(all(test, unix))]
            if let Some(expected) = create_mode {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&tmp)
                    .map_err(|e| format!("stat temp: {e}"))?
                    .permissions()
                    .mode()
                    & 0o777;
                let exp = expected & 0o777;
                if mode != exp {
                    return Err(format!(
                        "temp mode at create {mode:o} != expected {exp:o}"
                    ));
                }
            }
            return Err("injected: after create".into());
        }

        if fault == Some(AtomicWriteFault::AfterPartialWrite) {
            if !bytes.is_empty() {
                f.write_all(&bytes[..1])
                    .map_err(|e| format!("temp partial write {}: {e}", tmp.display()))?;
            }
            return Err("injected: after partial write".into());
        }

        f.write_all(bytes)
            .map_err(|e| format!("temp write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("temp sync {}: {e}", tmp.display()))?;

        if fault == Some(AtomicWriteFault::BeforeRename) {
            return Err("injected: before rename".into());
        }
        Ok(())
    };

    if let Err(e) = write_tmp() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    if fault == Some(AtomicWriteFault::Rename) {
        let _ = fs::remove_file(&tmp);
        return Err("injected: rename".into());
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

    // Best-effort directory sync — rename already committed the new bytes.
    #[cfg(unix)]
    {
        match File::open(parent).and_then(|dir| dir.sync_all()) {
            Ok(()) => Ok(AtomicWriteOutcome::Committed),
            Err(e) => Ok(AtomicWriteOutcome::PostCommitDirSync {
                message: format!("dir sync {}: {e}", parent.display()),
            }),
        }
    }
    #[cfg(not(unix))]
    {
        Ok(AtomicWriteOutcome::Committed)
    }
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

    fn leftover_temps(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".tmp"))
            })
            .collect()
    }

    #[test]
    fn successful_replacement_is_readable() {
        let dir = tmp_dir("ok");
        let path = dir.join("proj.json");
        fs::write(&path, b"old").unwrap();
        let out = atomic_write(&path, b"{\"ok\":true}").unwrap();
        assert_eq!(out, AtomicWriteOutcome::Committed);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":true}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_after_create_leaves_previous_bytes() {
        let dir = tmp_dir("inj_create");
        let path = dir.join("proj.json");
        fs::write(&path, b"keep-me").unwrap();
        set_test_fault(Some(AtomicWriteFault::AfterCreate));
        let err = atomic_write(&path, b"new").unwrap_err();
        assert!(err.contains("injected"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep-me");
        assert!(leftover_temps(&dir).is_empty(), "temp cleaned");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_partial_write_leaves_previous_bytes() {
        let dir = tmp_dir("inj_partial");
        let path = dir.join("proj.json");
        fs::write(&path, b"keep-me").unwrap();
        set_test_fault(Some(AtomicWriteFault::AfterPartialWrite));
        let err = atomic_write(&path, b"ABCDEF").unwrap_err();
        assert!(err.contains("injected"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep-me");
        assert!(leftover_temps(&dir).is_empty(), "temp cleaned");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_before_rename_leaves_previous_bytes() {
        let dir = tmp_dir("inj_before");
        let path = dir.join("proj.json");
        fs::write(&path, b"keep-me").unwrap();
        set_test_fault(Some(AtomicWriteFault::BeforeRename));
        let err = atomic_write(&path, b"new-full").unwrap_err();
        assert!(err.contains("injected"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep-me");
        assert!(leftover_temps(&dir).is_empty(), "temp cleaned");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_rename_leaves_previous_bytes() {
        let dir = tmp_dir("inj_rename");
        let path = dir.join("proj.json");
        fs::write(&path, b"keep-me").unwrap();
        set_test_fault(Some(AtomicWriteFault::Rename));
        let err = atomic_write(&path, b"new-full").unwrap_err();
        assert!(err.contains("injected"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep-me");
        assert!(leftover_temps(&dir).is_empty(), "temp cleaned");
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

    #[cfg(unix)]
    #[test]
    fn secrets_mode_at_create_before_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("sec_create");
        let path = dir.join("secrets.json");
        fs::write(&path, b"old").unwrap();
        set_test_fault(Some(AtomicWriteFault::AfterCreate));
        // Production path checks temp mode == 0600 before returning injected err.
        let err = atomic_write_with_mode(&path, b"SECRET", Some(0o600)).unwrap_err();
        assert!(
            err.contains("injected: after create"),
            "mode check must pass before inject: {err}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert!(leftover_temps(&dir).is_empty());

        atomic_write_with_mode(&path, b"{\"k\":1}", Some(0o600)).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn replace_preserves_existing_project_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("mode");
        let path = dir.join("proj.json");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        atomic_write(&path, b"new").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "replace must keep prior 0600");
        let _ = fs::remove_dir_all(&dir);
    }
}

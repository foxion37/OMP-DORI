//! `checkpoint-lock.ts` `takeLock` parity: the writer-lock file shared with the TypeScript CLI and extension.
//!
//! The lock is a regular file holding `{"pid","host","at","nonce"}`. A lock directory (an earlier build's) has no
//! record and is aged by its mtime. Takeover and release move the path aside first and only remove what they judged.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::util::{iso, now_ms, parse_iso, remove_any, sibling, uuid};

/// `LOCK_STALE_MS`.
pub(super) const LOCK_STALE_MS: i64 = 2 * 60_000;

#[derive(Serialize)]
struct Owner<'a> {
    pid: u32,
    host: &'a str,
    at: &'a str,
    nonce: &'a str,
}

#[derive(Deserialize)]
struct SeenOwner {
    pid: f64,
    host: String,
    at: String,
    #[serde(rename = "nonce")]
    _nonce: String,
}

struct Seen {
    raw: Option<Vec<u8>>,
    ino: u64,
    mtime_ms: i64,
}

/// A held writer lock; `release` (or drop) gives it back only while it still holds this writer's record.
#[derive(Debug)]
pub(in crate::discord) struct Lock {
    path: PathBuf,
    record: Vec<u8>,
    released: bool,
}

/// `os.hostname()`, read once. rustix's `system` feature (uname) is not enabled in this crate.
static HOST: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    #[cfg(target_os = "linux")]
    let read = fs::read_to_string("/proc/sys/kernel/hostname").ok();
    #[cfg(not(target_os = "linux"))]
    let read = std::process::Command::new("/bin/hostname")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok());
    read.map_or_else(String::new, |name| name.trim_end_matches('\n').to_owned())
});

pub(super) fn hostname() -> String {
    HOST.clone()
}

/// `alive(pid)`: signal 0 succeeds or is refused with EPERM. A pid that is not a safe integer cannot be signaled.
fn alive(pid: Option<i64>) -> bool {
    let Some(pid) = pid else { return false };
    if pid <= 0 {
        // process.kill(0 or negative, 0) addresses a process group that includes the caller.
        return true;
    }
    let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    matches!(
        rustix::process::test_kill_process(pid),
        Ok(()) | Err(rustix::io::Errno::PERM)
    )
}

fn inspect(path: &Path) -> Result<Option<Seen>> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let raw = if meta.is_dir() {
        None
    } else {
        match crate::util::read_limited(path, 64 * 1024) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    };
    let mtime_ms = meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000;
    Ok(Some(Seen {
        raw,
        ino: meta.ino(),
        mtime_ms,
    }))
}

fn owner_of(raw: Option<&[u8]>) -> Option<SeenOwner> {
    serde_json::from_slice(raw?).ok()
}

/// `takeLock(lock, now, fail, { keepLiveOwner })`: `Ok(Err(holder))` names why another writer holds it.
pub(in crate::discord) fn take_lock(
    path: &Path,
    keep_live_owner: bool,
) -> Result<Result<Lock, String>> {
    let host = hostname();
    let now = now_ms();
    let at = iso(now);
    let nonce = uuid()?;
    let record = serde_json::to_vec(&Owner {
        pid: std::process::id(),
        host: &host,
        at: &at,
        nonce: &nonce,
    })?;
    for _ in 0..3 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut file) => {
                file.write_all(&record)?;
                file.sync_all()?;
                return Ok(Ok(Lock {
                    path: path.to_owned(),
                    record,
                    released: false,
                }));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error).with_context(|| format!("taking lock {}", path.display()));
            }
        }
        let Some(seen) = inspect(path)? else { continue };
        let owner = owner_of(seen.raw.as_deref());
        let since = owner
            .as_ref()
            .and_then(|owner| parse_iso(&owner.at))
            .unwrap_or(seen.mtime_ms);
        let local = owner.as_ref().is_some_and(|owner| owner.host == host);
        let owner_pid = owner
            .as_ref()
            .and_then(|owner| crate::util::safe_int(owner.pid));
        let dead = local && !alive(owner_pid);
        let kept = keep_live_owner && local && !dead;
        if !dead && (kept || now - since < LOCK_STALE_MS) {
            let age = ((now - since).max(0) + 500) / 1000;
            let who = owner.map_or_else(
                || "no owner record".to_owned(),
                |owner| format!("pid {}", js_number(owner.pid)),
            );
            return Ok(Err(format!("{who}, {age} s old")));
        }
        let moved = sibling(path, &format!(".{}.{}.stale", std::process::id(), uuid()?));
        match fs::rename(path, &moved) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
        let taken = inspect(&moved)?;
        if taken
            .as_ref()
            .is_some_and(|taken| taken.ino == seen.ino && taken.raw == seen.raw)
        {
            remove_any(&moved)?;
            continue;
        }
        if let Err(error) = fs::hard_link(&moved, path) {
            return Err(anyhow!(
                "lock {} a live writer's lock could not be put back; it is kept at {}: {error}",
                path.display(),
                moved.display()
            ));
        }
        remove_any(&moved)?;
    }
    Ok(Err(
        "the lock changed hands while taking it over; retry".to_owned()
    ))
}

/// `String(n)` for the integral pids a lock record carries.
fn js_number(value: f64) -> String {
    crate::util::safe_int(value).map_or_else(|| value.to_string(), |n| i64::to_string(&n))
}

impl Lock {
    /// The release closure `takeLock` returns.
    pub(in crate::discord) fn release(mut self) -> Result<()> {
        self.release_now()
    }

    fn release_now(&mut self) -> Result<()> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        let aside = sibling(
            &self.path,
            &format!(".{}.{}.release", std::process::id(), uuid()?),
        );
        match fs::rename(&self.path, &aside) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        if inspect(&aside)?.and_then(|seen| seen.raw).as_deref() == Some(self.record.as_slice()) {
            return remove_any(&aside);
        }
        if let Err(error) = fs::hard_link(&aside, &self.path) {
            return Err(anyhow!(
                "lock {} belongs to another writer and could not be put back; it is at {}: {error}",
                self.path.display(),
                aside.display()
            ));
        }
        remove_any(&aside)
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if let Err(error) = self.release_now() {
            eprintln!("WARN lock: {error:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cataly-lock-{}", uuid().unwrap()));
        fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn a_live_lock_is_held_and_released() {
        let dir = temp();
        let path = dir.join("a.deliver.lock");
        let lock = take_lock(&path, true).unwrap().unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["pid"], serde_json::json!(std::process::id()));
        assert!(
            raw["nonce"]
                .as_str()
                .is_some_and(|n| crate::util::is_uuid(n, true))
        );
        let held = take_lock(&path, true).unwrap().unwrap_err();
        assert!(
            held.starts_with(&format!("pid {}, ", std::process::id())),
            "{held}"
        );
        lock.release().unwrap();
        assert!(!path.exists());
        take_lock(&path, false).unwrap().unwrap().release().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_dead_or_stale_owner_is_taken_over() {
        let dir = temp();
        let path = dir.join("b.lock");
        let dead = format!(
            r#"{{"pid":2147483646,"host":"{}","at":"{}","nonce":"x"}}"#,
            hostname(),
            iso(now_ms())
        );
        fs::write(&path, dead).unwrap();
        let lock = take_lock(&path, true).unwrap().unwrap();
        drop(lock);
        fs::write(
            &path,
            r#"{"pid":1,"host":"elsewhere","at":"2000-01-01T00:00:00.000Z","nonce":"x"}"#,
        )
        .unwrap();
        take_lock(&path, false).unwrap().unwrap().release().unwrap();
        fs::write(
            &path,
            format!(
                r#"{{"pid":1,"host":"elsewhere","at":"{}","nonce":"x"}}"#,
                iso(now_ms())
            ),
        )
        .unwrap();
        assert!(take_lock(&path, false).unwrap().is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_foreign_record_is_never_removed_on_release() {
        let dir = temp();
        let path = dir.join("c.lock");
        let lock = take_lock(&path, false).unwrap().unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, "other").unwrap();
        lock.release().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"other");
        fs::remove_dir_all(dir).unwrap();
    }
}

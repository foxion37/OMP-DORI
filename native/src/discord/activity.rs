//! `--activity-file` writer (src/update/source-activity.ts parity, platform "discord").
//!
//! The record contains no message text, IDs, tokens or transcript data. A write error is a required safety signal:
//! the caller must not advance its cursors.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use serde::Serialize;
use serde_json::Value;

const PLATFORMS: [&str; 3] = ["discord", "telegram", "slack"];
const MAX_JSON: u64 = 64 * 1024;
const MAX_SAFE: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    pid: u32,
    start_ticks: String,
    boot_id: String,
    executable: String,
    image_dev: String,
    image_ino: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u8,
    platform: &'static str,
    process: Identity,
    quiet_since: u64,
    healthy_at: u64,
    updated_at: u64,
    available: bool,
}

pub(super) struct Activity {
    path: PathBuf,
    lock: PathBuf,
    identity: Identity,
    record: Record,
    closed: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .ok_or_else(|| anyhow!("--activity-file must be an absolute path"))
}

/// `owned()`: a real (not symlinked) file or directory of this user, not group/other writable.
fn owned(path: &Path, directory: bool) -> Result<()> {
    let stat = fs::symlink_metadata(path)?;
    let kind = if directory {
        stat.is_dir()
    } else {
        stat.is_file()
    };
    ensure!(
        kind && !stat.file_type().is_symlink()
            && stat.mode() & 0o022 == 0
            && stat.uid() == rustix::process::getuid().as_raw(),
        "Inbound activity must use an owned protected file and directory"
    );
    Ok(())
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn read_json(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_JSON,
        "{} is too large",
        path.display()
    );
    Ok(serde_json::from_str(&String::from_utf8_lossy(&bytes))?)
}

fn digits(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
}

fn safe_integer(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    (number.fract() == 0.0 && (0.0..=MAX_SAFE as f64).contains(&number)).then_some(number as u64)
}

/// readRecord validation; the record is only checked, never reused.
fn check_record(path: &Path) -> Result<()> {
    owned(parent(path)?, true)?;
    owned(path, false)?;
    let value = read_json(path)?;
    let process = value.get("process");
    let field = |key: &str| process.and_then(|p| p.get(key));
    let valid = value.get("version").and_then(Value::as_f64) == Some(1.0)
        && value
            .get("platform")
            .and_then(Value::as_str)
            .is_some_and(|platform| PLATFORMS.contains(&platform))
        && value.get("available").is_some_and(Value::is_boolean)
        && process.is_some_and(Value::is_object)
        && safe_integer(field("pid")).is_some_and(|pid| pid > 0)
        && digits(field("startTicks"))
        && field("bootId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && field("executable")
            .and_then(Value::as_str)
            .is_some_and(|exe| exe.starts_with('/'))
        && digits(field("imageDev"))
        && digits(field("imageIno"))
        && ["quietSince", "healthyAt", "updatedAt"]
            .iter()
            .all(|key| safe_integer(value.get(*key)).is_some());
    ensure!(valid, "Inbound activity record is incomplete");
    Ok(())
}

/// processIdentity(pid) on Linux: /proc start ticks (stat field 22), boot id, exe link target and image dev/ino.
#[cfg(target_os = "linux")]
fn identity(pid: u32) -> Option<Identity> {
    if pid == 0 {
        return None;
    }
    let root = PathBuf::from(format!("/proc/{pid}"));
    let stat = fs::read_to_string(root.join("stat")).ok()?;
    let fields: Vec<&str> = stat.get(stat.rfind(')')? + 2..)?.split(' ').collect();
    let start_ticks = (*fields.get(19)?).to_owned();
    if start_ticks.is_empty()
        || !start_ticks.bytes().all(|b| b.is_ascii_digit())
        || fields.first() == Some(&"Z")
    {
        return None;
    }
    let image = fs::metadata(root.join("exe")).ok()?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let executable = fs::read_link(root.join("exe"))
        .ok()?
        .into_os_string()
        .into_string()
        .ok()?;
    Some(Identity {
        pid,
        start_ticks,
        boot_id: boot_id.trim().to_owned(),
        executable,
        image_dev: image.dev().to_string(),
        image_ino: image.ino().to_string(),
    })
}

/// processIdentity(pid) on macOS (src/platform/darwin.ts): libproc start token and status, `kern.bootsessionuuid`, and
/// libproc's executable path, which is both the recorded executable and the image whose dev/ino is recorded.
#[cfg(target_os = "macos")]
fn identity(pid: u32) -> Option<Identity> {
    if pid == 0 {
        return None;
    }
    let start_ticks = super::darwin::start(pid)?;
    let executable = super::darwin::executable(pid)?;
    let image = fs::metadata(&executable).ok()?;
    Some(Identity {
        pid,
        start_ticks,
        boot_id: super::darwin::boot_session()?,
        image_dev: image.dev().to_string(),
        image_ino: image.ino().to_string(),
        executable,
    })
}

/// No process readers on other hosts: fail closed like TS does when it has none.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn identity(_pid: u32) -> Option<Identity> {
    None
}

/// sameProcess(expected): compares image dev/ino when both are recorded, else the executable path.
fn same_process(expected: &Value) -> bool {
    let Some(pid) = safe_integer(expected.get("pid")).and_then(|pid| u32::try_from(pid).ok())
    else {
        return false;
    };
    let Some(current) = identity(pid) else {
        return false;
    };
    let text = |key: &str| expected.get(key).and_then(Value::as_str);
    let same_image = if expected.get("imageDev").is_some() && expected.get("imageIno").is_some() {
        text("imageDev") == Some(current.image_dev.as_str())
            && text("imageIno") == Some(current.image_ino.as_str())
    } else {
        text("executable") == Some(current.executable.as_str())
    };
    text("startTicks") == Some(current.start_ticks.as_str())
        && text("bootId") == Some(current.boot_id.as_str())
        && same_image
}

fn random_id() -> Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes.iter().fold(String::with_capacity(32), |mut hex, b| {
        use std::fmt::Write as _;
        // Writing to a String cannot fail.
        let _ = write!(hex, "{b:02x}");
        hex
    });
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn private_dirs(path: &Path) -> Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    Ok(())
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// acquireRestartLock: claim `<lock>/owner.json`, recovering only a provably dead holder.
fn acquire(lock: &Path, own: &Identity) -> Result<()> {
    private_dirs(parent(lock)?)?;
    let claim = || -> std::io::Result<()> {
        DirBuilder::new().mode(0o700).create(lock)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(lock.join("owner.json"))?;
        file.write_all(serde_json::to_string(own)?.as_bytes())
    };
    match claim() {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let holder =
        read_json(&lock.join("owner.json")).context("restart lock ownership is unknown")?;
    let wellformed = safe_integer(holder.get("pid")).is_some()
        && ["startTicks", "bootId", "executable"]
            .iter()
            .all(|key| holder.get(*key).is_some_and(Value::is_string));
    if !wellformed || same_process(&holder) {
        bail!("restart lock is held");
    }
    fs::rename(lock, sibling(lock, &format!(".stale-{}", random_id()?)))?;
    match claim() {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => bail!("restart lock is held"),
        Err(error) => Err(error.into()),
    }
}

/// saveDeploymentText: private temp file, fsync, rename, directory fsync; the temp name never survives.
fn save(path: &Path, text: &str) -> Result<()> {
    let directory = parent(path)?;
    private_dirs(directory)?;
    let tmp = sibling(path, &format!(".{}.tmp", random_id()?));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    match fs::remove_file(&tmp) {
        Err(error) if error.kind() != ErrorKind::NotFound && result.is_ok() => Err(error.into()),
        _ => result,
    }
}

fn pretty(value: &impl Serialize) -> Result<String> {
    Ok(format!("{}\n", serde_json::to_string_pretty(value)?))
}

impl Activity {
    pub(super) fn open(path: &Path) -> Result<Self> {
        ensure!(
            path.is_absolute(),
            "--activity-file must be an absolute path"
        );
        let identity = identity(std::process::id())
            .ok_or_else(|| anyhow!("Inbound process identity is unavailable"))?;
        private_dirs(parent(path)?)?;
        owned(parent(path)?, true)?;
        if exists(path)? {
            check_record(path)?;
        }
        let lock = sibling(path, ".lock");
        acquire(&lock, &identity)?;
        let at = now();
        let mut activity = Self {
            path: path.to_owned(),
            lock,
            identity: identity.clone(),
            record: Record {
                version: 1,
                platform: "discord",
                process: identity,
                quiet_since: at,
                healthy_at: 0,
                updated_at: at,
                available: false,
            },
            closed: false,
        };
        activity.publish(None)?;
        Ok(activity)
    }

    pub(super) fn received(&mut self) -> Result<()> {
        let at = now();
        self.record.quiet_since = at;
        self.record.updated_at = at;
        self.publish(None)
    }

    pub(super) fn healthy(&mut self) -> Result<()> {
        let at = now();
        if !self.record.available {
            self.record.quiet_since = at;
        }
        self.record.available = true;
        self.record.healthy_at = at;
        self.record.updated_at = at;
        self.publish(Some(at))
    }

    pub(super) fn unavailable(&mut self) -> Result<()> {
        self.record.available = false;
        self.record.updated_at = now();
        self.publish(None)
    }

    /// assertWriter: the lock still names this exact process.
    fn assert_writer(&self) -> Result<()> {
        owned(&self.lock, true)?;
        let owner = self.lock.join("owner.json");
        owned(&owner, false)?;
        let holder = read_json(&owner)?;
        let mine = serde_json::to_value(&self.identity)?;
        let same = [
            "pid",
            "startTicks",
            "bootId",
            "executable",
            "imageDev",
            "imageIno",
        ]
        .iter()
        .all(|key| holder.get(*key).is_some() && holder.get(*key) == mine.get(*key));
        ensure!(
            same && same_process(&mine),
            "Inbound activity writer is no longer current"
        );
        Ok(())
    }

    fn publish(&mut self, heartbeat: Option<u64>) -> Result<()> {
        ensure!(!self.closed, "Inbound activity writer is closed");
        let result = (|| -> Result<()> {
            self.assert_writer()?;
            owned(parent(&self.path)?, true)?;
            if exists(&self.path)? {
                owned(&self.path, false)?;
            }
            if let Some(at) = heartbeat {
                let pulse = sibling(&self.path, ".heartbeat");
                if exists(&pulse)? {
                    owned(&pulse, false)?;
                }
                save(&pulse, &pretty(&at)?)?;
            }
            save(&self.path, &pretty(&self.record)?)
        })();
        if let Err(error) = result {
            // The writer is unusable after a failed publication; a failed release is secondary to that error.
            let _released = self.close();
            return Err(error.context("Inbound activity publication failed"));
        }
        Ok(())
    }

    /// Releases the lease once: the lock directory is renamed away only while it still names this process.
    fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let holder = read_json(&self.lock.join("owner.json"))
            .context("Inbound activity lease release failed")?;
        let mine = serde_json::to_value(&self.identity)?;
        ensure!(
            holder.get("pid") == mine.get("pid")
                && holder.get("startTicks") == mine.get("startTicks")
                && holder.get("bootId") == mine.get("bootId")
                && holder.get("imageDev") == mine.get("imageDev")
                && holder.get("imageIno") == mine.get("imageIno"),
            "Inbound activity lease release failed"
        );
        fs::rename(
            &self.lock,
            sibling(&self.lock, &format!(".released-{}", random_id()?)),
        )
        .context("Inbound activity lease release failed")
    }
}

impl Drop for Activity {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("WARN activity: {error:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Record {
        Record {
            version: 1,
            platform: "discord",
            process: Identity {
                pid: 42,
                start_ticks: "123".into(),
                boot_id: "b".into(),
                executable: "/bin/cataly".into(),
                image_dev: "1".into(),
                image_ino: "2".into(),
            },
            quiet_since: 10,
            healthy_at: 0,
            updated_at: 11,
            available: false,
        }
    }

    #[test]
    fn record_matches_save_deployment_json() {
        assert_eq!(
            pretty(&sample()).unwrap(),
            "{\n  \"version\": 1,\n  \"platform\": \"discord\",\n  \"process\": {\n    \"pid\": 42,\n    \"startTicks\": \"123\",\n    \"bootId\": \"b\",\n    \"executable\": \"/bin/cataly\",\n    \"imageDev\": \"1\",\n    \"imageIno\": \"2\"\n  },\n  \"quietSince\": 10,\n  \"healthyAt\": 0,\n  \"updatedAt\": 11,\n  \"available\": false\n}\n"
        );
        assert_eq!(pretty(&5_u64).unwrap(), "5\n");
        assert_eq!(
            serde_json::to_string(&sample().process).unwrap(),
            r#"{"pid":42,"startTicks":"123","bootId":"b","executable":"/bin/cataly","imageDev":"1","imageIno":"2"}"#
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn own_identity_is_current() {
        let own = identity(std::process::id()).unwrap();
        assert!(own.executable.starts_with('/'));
        assert!(same_process(&serde_json::to_value(&own).unwrap()));
        let mut other = serde_json::to_value(&own).unwrap();
        other["startTicks"] = Value::from("0");
        assert!(!same_process(&other));
    }

    /// The record is reusable only while TypeScript's `processIdentity` reads the same fields for the same PID. Needs
    /// `bun`, so Linux runs it with `cargo test -- --ignored`.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[cfg_attr(
        not(target_os = "macos"),
        ignore = "runs the TypeScript readers with bun"
    )]
    #[test]
    fn identity_matches_typescript() {
        let pid = std::process::id();
        let ts = crate::discord::darwin::typescript_process(pid);
        assert_eq!(
            Some(ts["identity"].clone()),
            identity(pid).map(|own| serde_json::to_value(own).unwrap())
        );
    }

    #[test]
    fn safe_integers() {
        assert_eq!(safe_integer(Some(&Value::from(3))), Some(3));
        assert_eq!(safe_integer(Some(&Value::from(1.5))), None);
        assert_eq!(safe_integer(Some(&Value::from(-1))), None);
        assert_eq!(safe_integer(Some(&Value::from("3"))), None);
    }
}

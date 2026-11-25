//! macOS process facts for the receiver and activity identities, read as src/platform/darwin.ts reads them: libproc's
//! BSD info and executable path, and `kern.bootsessionuuid` for the boot. Every reader returns `None` when the fact is
//! unavailable, so callers keep failing closed.

/// darwin.ts `procStat().startTicks`: start seconds, then microseconds padded to six digits. The value is the
/// process's absolute start time, so a reused PID, here or after a reboot, reads another one.
pub(super) fn start_token(seconds: u64, micros: u64) -> String {
    format!("{seconds}{micros:06}")
}

/// The start token of a live, non-zombie `pid`; `None` when it is gone, a zombie, or another process answered.
#[cfg(target_os = "macos")]
pub(super) fn start(pid: u32) -> Option<String> {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;

    /// `<sys/proc.h>` SZOMB.
    const SZOMB: u32 = 5;
    let info = pidinfo::<BSDInfo>(i32::try_from(pid).ok()?, 0).ok()?;
    (info.pbi_pid == pid && info.pbi_status != SZOMB)
        .then(|| start_token(info.pbi_start_tvsec, info.pbi_start_tvusec))
}

/// darwin.ts `exePath`/`procExeLink`: libproc's executable path, which is both the identity token and the image path.
#[cfg(target_os = "macos")]
pub(super) fn executable(pid: u32) -> Option<String> {
    libproc::proc_pid::pidpath(i32::try_from(pid).ok()?)
        .ok()
        .filter(|path| !path.is_empty())
}

/// darwin.ts `bootId()`: `kern.bootsessionuuid`, which changes on every boot. Read once it has answered.
#[cfg(target_os = "macos")]
pub(super) fn boot_session() -> Option<String> {
    static BOOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(id) = BOOT.get() {
        return Some(id.clone());
    }
    let id = read_boot_session()?;
    Some(BOOT.get_or_init(|| id).clone())
}

/// `/usr/sbin/sysctl -n kern.bootsessionuuid`. The value darwin.ts reads with `sysctlbyname` into 64 bytes, so a
/// longer answer is refused like it is there.
#[cfg(target_os = "macos")]
fn read_boot_session() -> Option<String> {
    let text = sysctl(&["kern.bootsessionuuid"], 64)?;
    let id = text.strip_suffix('\n')?;
    (!id.is_empty() && id.len() < 64 && !id.contains(['\0', '\n'])).then(|| id.to_owned())
}

/// `/usr/sbin/sysctl -n <names>` under a cleared environment and `LC_ALL=C`: its whole output, one value per line,
/// or `None` unless it exits 0 within 2 s with at most `max` bytes of UTF-8.
#[cfg(target_os = "macos")]
pub(super) fn sysctl(names: &[&str], max: u64) -> Option<String> {
    use std::io::Read as _;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = Command::new("/usr/sbin/sysctl")
        .arg("-n")
        .args(names)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Each answer is a short line, far below a pipe's capacity: the child finishes before its output is read.
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let mut out = Vec::new();
    child
        .stdout
        .take()?
        .take(max + 1)
        .read_to_end(&mut out)
        .ok()?;
    let fits = u64::try_from(out.len()).is_ok_and(|len| len <= max);
    if !status.success() || !fits {
        return None;
    }
    String::from_utf8(out).ok()
}

/// What TypeScript computes for `pid`: `processIdentity` (src/update/deployment-process.ts) and `processStart`
/// (src/release/process-cwd.ts), the readers behind the activity record and the ASK receiver lookup.
#[cfg(test)]
pub(super) fn typescript_process(pid: u32) -> serde_json::Value {
    let root = env!("CARGO_MANIFEST_DIR");
    let script = format!(
        r#"import {{ processIdentity }} from "{root}/src/update/deployment-process.ts";
import {{ processStart }} from "{root}/src/release/process-cwd.ts";
import {{ bootId }} from "{root}/src/update/proc.ts";
const pid = Number(process.env.CATALY_TEST_PID);
console.log(JSON.stringify({{ identity: processIdentity(pid) ?? null, start: processStart(String(pid)) ?? null,
  bootId: bootId() }}));"#
    );
    let out = std::process::Command::new("bun")
        .args(["-e", &script])
        .env("CATALY_TEST_PID", pid.to_string())
        .stdin(std::process::Stdio::null())
        .output()
        .expect("bun runs the TypeScript process readers");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// darwin.ts: `${seconds}${micros.toString().padStart(6, "0")}`.
    #[test]
    fn start_token_matches_darwin_ts() {
        assert_eq!(start_token(1_700_000_000, 42), "1700000000000042");
        assert_eq!(start_token(1_700_000_000, 999_999), "1700000000999999");
        assert_eq!(start_token(1_700_000_001, 0), "1700000001000000");
        assert_eq!(start_token(5, 123_456), "5123456");
    }

    /// A live child has its own start; once it exits it is a zombie and then gone, and neither has a start.
    #[cfg(target_os = "macos")]
    #[test]
    fn readers_refuse_zombies_and_absent_processes() {
        let own = start(std::process::id()).unwrap();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        let live = start(pid).unwrap();
        assert_ne!(live, own);
        assert_eq!(executable(pid).as_deref(), Some("/bin/sleep"));
        child.kill().unwrap();
        let mut zombie = false;
        for _ in 0..400 {
            if start(pid).is_none() {
                zombie = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(zombie, "an exited, unreaped child is a zombie");
        child.wait().unwrap();
        assert_eq!(start(pid), None);
        assert_eq!(start(u32::MAX), None);
        let boot = boot_session().unwrap();
        assert_eq!(boot.len(), 36);
        assert_eq!(boot_session().as_deref(), Some(boot.as_str()));
    }
}

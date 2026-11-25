//! Small shared helpers: JS-compatible time stamps, UUIDs, bounded reads and private files.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};

/// Largest JSON state record any lane module reads (registry rows, pane and headless records).
pub const RECORD_LIMIT: u64 = 4 * 1024 * 1024;
#[cfg(feature = "discord")]
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// A JS number that is a safe integer, as `Number.isSafeInteger` decides.
#[cfg(feature = "discord")]
#[allow(clippy::cast_possible_truncation)]
pub fn safe_int(value: f64) -> Option<i64> {
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE).then_some(value as i64)
}

const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

/// `new Date(ms).toISOString()` for years 0..=9999.
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// An HTTP `Date` header value (IMF-fixdate, `Tue, 24 Nov 2026 05:22:19 GMT`) for `ms` since the epoch.
pub fn http_date(ms: i64) -> String {
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000) / 1000;
    let (year, month, day) = civil_from_days(days);
    // Both indices are reduced into range, so the lookups cannot fail.
    let weekday = WEEKDAYS[usize::try_from(days.rem_euclid(7)).unwrap_or_default()];
    let month = MONTHS[usize::try_from(month - 1).unwrap_or_default()];
    format!(
        "{weekday}, {day:02} {month} {year:04} {:02}:{:02}:{:02} GMT",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

fn number(text: &str, digits: usize) -> Option<i64> {
    if text.len() == digits && text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

/// `Date.parse` for the ISO forms Cataly writes: a date, or a date-time with `Z` or a `±HH:MM` offset.
pub fn parse_iso(text: &str) -> Option<i64> {
    let (date, time) = text
        .split_once('T')
        .map_or((text, None), |(d, t)| (d, Some(t)));
    let mut parts = date.split('-');
    let year = number(parts.next()?, 4)?;
    let month = number(parts.next()?, 2)?;
    let day = number(parts.next()?, 2)?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let base = days_from_civil(year, month, day) * 86_400_000;
    let Some(time) = time else {
        return Some(base);
    };
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, zone) = time.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = zone.get(1..)?.split_once(':')?;
        (
            clock,
            sign * (number(hours, 2)? * 60 + number(minutes, 2)?) * 60_000,
        )
    };
    let (whole, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let mut fields = whole.split(':');
    let hour = number(fields.next()?, 2)?;
    let minute = number(fields.next()?, 2)?;
    let second = fields.next().map_or(Some(0), |s| number(s, 2))?;
    if fields.next().is_some() || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    let millis = if fraction.is_empty() {
        0
    } else {
        if !fraction.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let mut padded = fraction.chars().take(3).collect::<String>();
        while padded.len() < 3 {
            padded.push('0');
        }
        padded.parse::<i64>().ok()?
    };
    Some(base + ((hour * 60 + minute) * 60 + second) * 1000 + millis - offset)
}

/// Lowercase hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// A random version-4 UUID (`crypto.randomUUID()` format).
pub fn uuid() -> Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex(&bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` when `v4`, else any lowercase UUID shape.
#[cfg(any(test, feature = "discord"))]
pub fn is_uuid(text: &str, v4: bool) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, b)| {
            if matches!(at, 8 | 13 | 18 | 23) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
        && (!v4 || (bytes[14] == b'4' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')))
}

/// Whether `text` contains a Unicode `Cc` control character (`\p{Cc}`).
#[cfg(feature = "discord")]
pub fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

/// `path` with `suffix` appended to its last component.
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

/// Reads a whole file, failing above `limit` bytes.
pub fn read_limited(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(std::io::Error::other(format!(
            "{} exceeds its size limit",
            path.display()
        )));
    }
    Ok(bytes)
}

/// `mkdirSync(path, { recursive: true, mode: 0o700 })`.
#[cfg(feature = "discord")]
pub fn private_dirs(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt as _;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .with_context(|| format!("creating {}", path.display()))
}

/// Writes `text` to a fresh owner-only temporary sibling and renames it over `path`.
pub fn replace_file(path: &Path, temporary: &Path, text: &str) -> Result<()> {
    if let Err(error) = fs::remove_file(temporary)
        && error.kind() != ErrorKind::NotFound
    {
        return Err(error.into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(temporary)
        .with_context(|| format!("creating {}", temporary.display()))?;
    file.write_all(text.as_bytes())?;
    drop(file);
    fs::rename(temporary, path).with_context(|| format!("replacing {}", path.display()))
}

/// `rmSync(path, { recursive: true, force: true })`.
pub fn remove_any(path: &Path) -> Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) => Err(error),
    };
    match result {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Whether `pid` names a live process as `process.kill(pid, 0)` succeeding decides (EPERM is a failure here).
#[cfg(feature = "discord")]
pub fn signalable(pid: i64) -> bool {
    i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
}

/// Ensures `path` is absolute.
#[cfg(feature = "discord")]
pub fn absolute(path: &Path, what: &str) -> Result<()> {
    anyhow::ensure!(path.is_absolute(), "{what} must be an absolute path");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips() {
        let at = 1_795_000_000_123;
        assert_eq!(iso(at), "2026-11-18T11:06:40.123Z");
        assert_eq!(parse_iso(&iso(at)), Some(at));
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_iso("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_iso("nope"), None);
    }

    #[test]
    fn uuids_are_v4() {
        let id = uuid().unwrap();
        assert!(is_uuid(&id, true), "{id}");
        assert!(!is_uuid("x", false));
    }
}

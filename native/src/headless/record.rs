//! The headless runtime's owner-only on-disk records (`src/runtime/headless-record.ts`).
//!
//! `<state>/headless/<uuid>/` holds `reservation.json`, `started`, `host.yml`, `endpoint.json` and `stopped.json`
//! (plus the lane extension's `discord-lane.json`), each owner-only. Old Bun brokers and this host read and write
//! the same shapes, so every record here keeps the TypeScript keys and their emission order.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow, ensure};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::json::Json;
use crate::util::{RECORD_LIMIT, hex, read_limited, replace_file, sibling, uuid};

/// The `--config` overlay OMP runs with: RPC-driven goal continuation and asks that never time out.
pub const HOST_CONFIG: &str = "goal:\n  continuationModes: [rpc]\nask:\n  timeout: 0\n";

/// `dataDir(stateDir)`.
#[cfg(any(test, feature = "discord"))]
pub fn data_dir(state: &Path) -> PathBuf {
    state.join("headless")
}

/// `laneDir`: refuses an id that is not a lowercase UUID.
#[cfg(any(test, feature = "discord"))]
pub fn lane_dir(state: &Path, id: &str) -> Result<PathBuf> {
    ensure!(
        crate::util::is_uuid(id, false),
        "invalid headless session ref"
    );
    Ok(data_dir(state).join(id))
}

fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}

/// `privateDir`.
pub fn private_dir(dir: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(dir)?;
    ensure!(
        stat.is_dir() && stat.uid() == uid() && stat.mode().trailing_zeros() >= 6,
        "headless state directory is not owner-only"
    );
    Ok(())
}

/// `readPrivate`: absent is `None`; a non-private file or non-object record is an error.
pub fn read_private(path: &Path) -> Result<Option<Json>> {
    let stat = match fs::symlink_metadata(path) {
        Ok(stat) => stat,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        stat.is_file() && stat.uid() == uid() && stat.mode().trailing_zeros() >= 6,
        "headless state file is not owner-only"
    );
    let bytes = match read_limited(path, RECORD_LIMIT) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value: Json = serde_json::from_slice(&bytes)?;
    ensure!(value.is_object(), "invalid headless state record");
    Ok(Some(value))
}

/// `writePrivate`: `JSON.stringify(value)` to `<path>.<uuid>` (exclusive, 0600), then rename.
pub fn write_private(path: &Path, value: &Json) -> Result<()> {
    let temporary = sibling(path, &format!(".{}", uuid()?));
    replace_file(path, &temporary, &value.compact())
}

/// A reserved lane directory and its `reservation.json`.
#[cfg(any(test, feature = "discord"))]
pub struct Entry {
    pub(crate) dir: PathBuf,
    pub(crate) reservation: Json,
}

/// `laneEntry`.
#[cfg(any(test, feature = "discord"))]
pub fn lane_entry(state: &Path, id: &str) -> Result<Option<Entry>> {
    let dir = lane_dir(state, id)?;
    if !data_dir(state).exists() || !dir.exists() {
        return Ok(None);
    }
    private_dir(&data_dir(state))?;
    private_dir(&dir)?;
    let reservation = read_private(&dir.join("reservation.json"))?;
    let valid = reservation.as_ref().is_some_and(|reservation| {
        let reference_ok = reservation
            .get("ref")
            .is_some_and(|r| r.str("runtime") == Some("headless") && r.str("id") == Some(id));
        let role_ok = reservation.get("role").is_none_or(|role| {
            matches!(
                role.as_str(),
                Some("lane" | "lead" | "duty" | "duty-loop" | "hourly-loop")
            )
        });
        reference_ok && role_ok
    });
    let Some(reservation) = reservation.filter(|_| valid) else {
        anyhow::bail!("headless reservation identity unreadable");
    };
    Ok(Some(Entry { dir, reservation }))
}

/// An explicit child environment, in start-record order.
pub type Env = Vec<(String, String)>;

/// `HostStart`, read from standard input to EOF (`Bun.stdin.json()`).
#[derive(Debug)]
pub struct HostStart {
    pub(crate) argv: Vec<Value>,
    pub(crate) env: serde_json::Map<String, Value>,
    /// `undefined` is `None`; any present value, `null` included, must equal the bound session ID.
    pub(crate) expected_resume_id: Option<Value>,
}

impl HostStart {
    /// `Array.isArray(start.argv) && object(start.env)`, else `invalid headless start`.
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        let value: Value = serde_json::from_slice(bytes).context("invalid headless start")?;
        let start = value.as_object();
        let argv = start.and_then(|start| start.get("argv")?.as_array());
        let env = start.and_then(|start| start.get("env")?.as_object());
        let (Some(argv), Some(env)) = (argv, env) else {
            anyhow::bail!("invalid headless start");
        };
        Ok(Self {
            argv: argv.clone(),
            env: env.clone(),
            expected_resume_id: start.and_then(|start| start.get("expectedResumeId").cloned()),
        })
    }

    /// The argv and environment as strings; the launchers only ever write strings.
    pub(crate) fn strings(&self) -> Result<(Vec<String>, Env)> {
        let argv = self
            .argv
            .iter()
            .map(|arg| arg.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>();
        let env = self
            .env
            .iter()
            .map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect::<Option<Vec<_>>>();
        argv.zip(env)
            .ok_or_else(|| anyhow!("invalid headless start"))
    }
}

/// Writes `host.yml` exclusively (0600) and returns its path.
pub fn write_host_config(dir: &Path) -> Result<PathBuf> {
    let path = dir.join("host.yml");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("creating {}", path.display()))?;
    file.write_all(HOST_CONFIG.as_bytes())?;
    Ok(path)
}

/// `mkdtempSync("/tmp/cataly-rpc-")`: a fresh owner-only directory with a six-character alphanumeric suffix.
/// Darwin Unix addresses cap at 104 bytes; this keeps the socket path short and host-local.
pub fn socket_dir() -> Result<PathBuf> {
    const ALPHABET: &[u8; 62] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for _ in 0..100 {
        let mut bytes = [0_u8; 6];
        File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        let suffix: String = bytes
            .iter()
            .map(|byte| char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()]))
            .collect();
        let dir = PathBuf::from(format!("/tmp/cataly-rpc-{suffix}"));
        match DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("creating the headless socket directory"),
        }
    }
    anyhow::bail!("creating the headless socket directory")
}

/// `sha256(randomUUID() + randomUUID())` as 64 lowercase hex digits.
pub fn endpoint_key() -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(uuid()?);
    hash.update(uuid()?);
    Ok(hex(&hash.finalize()))
}

/// `endpoint.json`: `{socket, key, pid}` with the host's own pid.
pub fn endpoint(socket: &str, key: &str, pid: u32) -> Json {
    Json::object(vec![
        ("socket", Json::string(socket)),
        ("key", Json::string(key)),
        ("pid", Json::Number(pid.into())),
    ])
}

/// `stopped.json`: `{detail?, closedSessionId?}` and nothing else.
pub fn stop_receipt(detail: Option<&str>, closed_session_id: Option<&str>) -> Json {
    let mut fields = Vec::new();
    if let Some(detail) = detail {
        fields.push(("detail", Json::string(detail)));
    }
    if let Some(closed) = closed_session_id {
        fields.push(("closedSessionId", Json::string(closed)));
    }
    Json::object(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cataly-record-{}", uuid().unwrap()));
        DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir
    }

    #[test]
    fn records_round_trip_in_typescript_order() {
        let dir = private_tmp();
        let reservation = Json::object(vec![
            (
                "ref",
                Json::object(vec![
                    ("runtime", Json::string("headless")),
                    ("id", Json::string("x")),
                ]),
            ),
            ("cwd", Json::string("/w")),
            ("name", Json::string("n")),
            ("role", Json::string("lane")),
            ("startedAt", Json::string("2026-01-01T00:00:00.000Z")),
        ]);
        let path = dir.join("reservation.json");
        write_private(&path, &reservation).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"ref":{"runtime":"headless","id":"x"},"cwd":"/w","name":"n","role":"lane","startedAt":"2026-01-01T00:00:00.000Z"}"#
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(read_private(&path).unwrap(), Some(reservation));
        assert_eq!(read_private(&dir.join("absent.json")).unwrap(), None);
        // Only the target remains: the exclusive temporary was renamed over it.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        assert_eq!(
            endpoint("/tmp/cataly-rpc-Ab12Cd/socket", "k", 7).compact(),
            r#"{"socket":"/tmp/cataly-rpc-Ab12Cd/socket","key":"k","pid":7}"#
        );
        assert_eq!(stop_receipt(None, None).compact(), "{}");
        assert_eq!(
            stop_receipt(Some("headless process exited (3)"), Some("s")).compact(),
            r#"{"detail":"headless process exited (3)","closedSessionId":"s"}"#
        );

        let config = write_host_config(&dir).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), HOST_CONFIG);
        assert_eq!(fs::metadata(&config).unwrap().mode() & 0o777, 0o600);
        assert!(write_host_config(&dir).is_err(), "host.yml is exclusive");

        fs::write(dir.join("loose.json"), "{}").unwrap();
        fs::set_permissions(
            dir.join("loose.json"),
            std::os::unix::fs::PermissionsExt::from_mode(0o644),
        )
        .unwrap();
        assert!(read_private(&dir.join("loose.json")).is_err());
        fs::write(dir.join("array.json"), "[]").unwrap();
        fs::set_permissions(
            dir.join("array.json"),
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        assert!(read_private(&dir.join("array.json")).is_err());
        private_dir(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lane_entries_validate_identity_and_role() {
        let state = private_tmp();
        let id = uuid().unwrap();
        assert!(lane_entry(&state, &id).unwrap().is_none());
        assert!(lane_entry(&state, "not-a-uuid").is_err());
        let dir = lane_dir(&state, &id).unwrap();
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .unwrap();
        let reservation = |role: &str| {
            Json::object(vec![
                (
                    "ref",
                    Json::object(vec![
                        ("runtime", Json::string("headless")),
                        ("id", Json::string(&id)),
                    ]),
                ),
                ("role", Json::string(role)),
            ])
        };
        write_private(&dir.join("reservation.json"), &reservation("duty-loop")).unwrap();
        let entry = lane_entry(&state, &id).unwrap().unwrap();
        assert_eq!(entry.dir, dir);
        assert_eq!(entry.reservation.str("role"), Some("duty-loop"));
        write_private(&dir.join("reservation.json"), &reservation("unknown")).unwrap();
        assert!(lane_entry(&state, &id).is_err());
        fs::remove_dir_all(&state).unwrap();
    }

    #[test]
    fn start_records_parse_like_the_bun_broker() {
        let start = HostStart::parse(
            br#"{"argv":["omp","--x"],"env":{"PATH":"/bin"},"expectedResumeId":"s"}"#,
        )
        .unwrap();
        let (argv, env) = start.strings().unwrap();
        assert_eq!(argv, ["omp", "--x"]);
        assert_eq!(env, [("PATH".to_owned(), "/bin".to_owned())]);
        assert_eq!(start.expected_resume_id, Some(Value::from("s")));
        let fresh = HostStart::parse(br#"{"argv":[],"env":{}}"#).unwrap();
        assert_eq!(fresh.expected_resume_id, None);
        for bad in [
            &br#"{"argv":{},"env":{}}"#[..],
            br#"{"argv":[]}"#,
            b"null",
            b"",
        ] {
            assert!(HostStart::parse(bad).is_err());
        }
    }

    #[test]
    fn socket_dirs_and_keys_match_the_client_contract() {
        let dir = socket_dir().unwrap();
        let name = dir.to_str().unwrap();
        let suffix = name.strip_prefix("/tmp/cataly-rpc-").unwrap();
        assert!(suffix.len() == 6 && suffix.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        fs::remove_dir(&dir).unwrap();
        let key = endpoint_key().unwrap();
        assert!(key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }
}

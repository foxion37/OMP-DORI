//! `cataly setup` (COORD-51, COORD-52, IR-09): the whole first run in one command, and every later
//! change of what it manages. It makes Cataly's folders owner-only (0700, files 0600, whatever the
//! umask), runs the Discord steps only the owner can take (the bot token, asked without echo; the
//! invite link, then a wait for the bot to join), and fills in the rest with defaults, asking
//! nothing: the application's owner as the owner, `#cataly` and `#cataly-ops` found or created,
//! OMP's default model for the lead, remote approvals on, the home backup to
//! `<gh login>/cataly-home`, the health and pressure jobs, and the user service. It shows one short
//! summary and asks one yes/no before it changes anything; `--yes` answers it in scripts. A default
//! is applied only where the config says nothing yet, so a second run shows what is set and changes
//! nothing; a flag changes its setting on any run.
//!
//! The config file is written without clobbering a hand edit: setup snapshots it (identity and
//! SHA-256), re-checks the snapshot just before an atomic replace (or a create that never
//! overwrites), and reads the file back. Unknown keys and comments are kept: only the managed lines
//! change. `--expect <hash>` makes a scripted edit refuse a file that changed since its preview.

use std::fmt::Write as _;
use std::io::BufRead as _;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};

use super::args::Parsed;
use super::install::block_on;
use super::setup_discord::{self as discord, Discord};
use super::{CALL_TIMEOUT, Failure, out};
use crate::config::{self, Config, sha256_hex};
use crate::omp::transcript::model_selector;
use crate::proto::{Status, method};
use crate::sys::fs::{create_atomic, read_private, write_atomic};
use crate::sys::install::Layout;
use crate::sys::paths::Paths;

/// The settings setup writes straight from their flags: (section, key, flag).
const MANAGED: [(&str, &str, &str); 14] = [
    ("hub", "log_level", "--log-level"),
    ("omp", "path", "--omp"),
    ("discord", "token_file", "--discord-token-file"),
    ("telegram", "token_file", "--telegram-token-file"),
    ("telegram", "owner", "--telegram-owner"),
    ("telegram", "group", "--telegram-group"),
    ("telegram", "topic", "--telegram-topic"),
    ("slack", "token_file", "--slack-token-file"),
    ("slack", "role", "--slack-role"),
    ("slack", "owner", "--slack-owner"),
    ("fallback", "on", "--fallback-on"),
    ("fallback.chains", "default", "--fallback-chain"),
    ("lead", "model", "--lead-model"),
    ("lead", "cwd", "--lead-cwd"),
];
/// The jobs a first run adds, each named after its kind, with their defaults.
const JOBS: [&str; 2] = ["health", "pressure"];
/// How long one question waits for its answer.
const ANSWER_WAIT: Duration = Duration::from_mins(30);

/// The owner's terminal. Answers are read on their own thread, so every wait for one is bounded.
pub(super) struct Terminal {
    lines: mpsc::Receiver<String>,
}

impl Terminal {
    /// The terminal, when stdin is one and JSON was not asked for; scripts get none.
    fn open(as_json: bool) -> Option<Self> {
        if as_json || !rustix::termios::isatty(std::io::stdin()) {
            return None;
        }
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Some(Self { lines })
    }

    /// One answer, trimmed; `None` when stdin closed or no answer came in time.
    pub(super) fn ask(&self, question: &str) -> Option<String> {
        out::prompt(&format!("{question} "));
        let answer = self.lines.recv_timeout(ANSWER_WAIT).ok();
        if answer.is_none() {
            out::line("");
        }
        answer.map(|a| a.trim().to_string())
    }

    fn yes(&self, question: &str) -> bool {
        match self.ask(&format!("{question} [Y/n]")).as_deref() {
            Some("") => true,
            Some(a) => matches!(a.to_ascii_lowercase().as_str(), "y" | "yes"),
            None => false,
        }
    }

    /// One answer typed without echo. `None` also when echo cannot be turned off: then nothing is
    /// asked, so a token never shows on the screen.
    pub(super) fn hidden(&self, question: &str) -> Option<String> {
        use rustix::termios::{LocalModes, OptionalActions, tcgetattr, tcsetattr};
        let stdin = std::io::stdin();
        let saved = tcgetattr(&stdin).ok()?;
        let mut quiet = saved.clone();
        quiet.local_modes.remove(LocalModes::ECHO);
        tcsetattr(&stdin, OptionalActions::Now, &quiet).ok()?;
        let answer = self.ask(question);
        let _ = tcsetattr(&stdin, OptionalActions::Now, &saved);
        out::line("");
        answer
    }
}
const CONFIG_MAX: u64 = 1024 * 1024;

/// Device, inode, mode, owner, group, size and the modification and change times.
type Identity = (u64, u64, u32, u32, u32, u64, i64, i64, i64, i64);

/// What identifies the file: any change of it means someone else wrote meanwhile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Snapshot {
    identity: Option<Identity>,
    pub(super) bytes: Option<Vec<u8>>,
}

impl Snapshot {
    pub(super) fn digest(&self) -> String {
        self.bytes
            .as_deref()
            .map_or_else(|| "none".to_string(), sha256_hex)
    }
}

pub(super) fn snapshot(path: &Path) -> Result<Snapshot, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Snapshot {
                identity: None,
                bytes: None,
            });
        }
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    // The same rule the hub applies when it reads the file: refuse, naming the fix.
    crate::sys::fs::check_private_file(path, &meta)
        .map_err(|e| format!("{e}; setup refuses it"))?;
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > CONFIG_MAX {
        return Err(format!("{} is larger than 1 MiB", path.display()));
    }
    Ok(Snapshot {
        identity: Some((
            meta.dev(),
            meta.ino(),
            meta.mode(),
            meta.uid(),
            meta.gid(),
            meta.size(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec(),
        )),
        bytes: Some(bytes),
    })
}

/// Why a managed owner, room or fallback value is not valid, if it is not.
fn invalid(section: &str, key: &str, v: &str) -> Option<&'static str> {
    let int = v.parse::<i64>().ok();
    let ok = match (section, key) {
        ("telegram", "owner") => int.is_some_and(|n| n > 0),
        ("telegram", "group") => int.is_some_and(|n| n < 0),
        ("telegram", "topic") => int.is_some_and(|n| n > 0),
        ("slack", "owner") => v.starts_with(['U', 'W']) && crate::config::relays::slack_id(v),
        ("slack", "role") => matches!(v, "app" | "member"),
        ("fallback", _) => config::session::FALLBACK_ON.contains(&v),
        ("fallback.chains", _) => {
            !comma_list(v).is_empty() && comma_list(v).iter().all(|m| model_selector(m))
        }
        ("lead", "model") => model_selector(v),
        ("lead", "cwd") => Path::new(v).is_absolute(),
        _ => true,
    };
    (!ok).then_some(match (section, key) {
        ("telegram", "owner") => "expected the owner's Telegram user ID (a positive number)",
        ("telegram", "group") => "expected the group's Telegram chat ID (a negative number)",
        ("telegram", _) => "expected the forum topic's ID (a positive number)",
        ("slack", "owner") => "expected the owner's Slack member ID, such as U0123ABCD",
        ("fallback", _) => "expected any, usage-limit or except-usage-limit",
        ("fallback.chains", _) => {
            "expected the models to fall back to, in order, as provider/id separated by commas"
        }
        ("lead", "model") => "expected the lead's model as provider/id",
        ("lead", _) => "expected the lead's working folder as an absolute path",
        _ => "expected app or member",
    })
}

/// The items of a comma-separated value, in order.
fn comma_list(v: &str) -> Vec<&str> {
    v.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// A TOML basic string.
pub(super) fn toml_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04X}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Sets `key` in `[section]` to `value`, replacing its line or adding it; everything else is kept.
pub(crate) fn set_key(text: &str, section: &str, key: &str, value: &str) -> String {
    set_rendered(text, section, key, &toml_string(value))
}

/// [`set_key`] with a value already written as TOML.
pub(super) fn set_rendered(text: &str, section: &str, key: &str, rendered: &str) -> String {
    let line = format!("{key} = {rendered}");
    let header = format!("[{section}]");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let start = lines.iter().position(|l| l.trim() == header);
    let Some(start) = start else {
        let mut out = text.trim_end().to_string();
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        let _ = write!(out, "{header}\n{line}\n");
        return out;
    };
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| l.trim_start().starts_with('['))
        .map_or(lines.len(), |(i, _)| i);
    let existing = (start + 1..end).find(|i| {
        lines
            .get(*i)
            .and_then(|l| l.trim_start().strip_prefix(key))
            .is_some_and(|rest| rest.trim_start().starts_with('='))
    });
    if let Some(i) = existing {
        if let Some(l) = lines.get_mut(i) {
            *l = line;
        }
    } else {
        let last = (start..end)
            .rev()
            .find(|i| lines.get(*i).is_some_and(|l| !l.trim().is_empty()))
            .unwrap_or(start);
        lines.insert(last + 1, line);
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

const NEW_FILE: &str = "# Cataly configuration. Check it with `cataly config check`; apply it with\n\
                        # `cataly config reload`. Jobs and destinations go below.\n";

/// Where the effective value of each managed setting comes from.
fn sources(paths: &Paths, text: &str, hub: Option<&Status>, digest: &str) -> Vec<Value> {
    let parsed = config::parse(text).ok();
    let defaults = config::Config::default();
    let effective = match hub {
        Some(s) if s.config_digest.as_deref() == Some(digest) => {
            "this file (the running hub applied it)"
        }
        Some(_) => {
            "this file, once applied: the running hub has a different version (run cataly config reload)"
        }
        None => "this file, when the hub starts (no hub is running)",
    };
    let mut out = Vec::new();
    let config = parsed.unwrap_or(defaults);
    for (section, key, _) in MANAGED {
        let from_file = in_file(text, section, key);
        let (value, note) = value_of(paths, &config, section, key);
        out.push(json!({
            "setting": format!("{section}.{key}"),
            "value": value,
            "source": if from_file { effective } else { "built-in default" },
            "note": note,
        }));
    }
    for (name, var, path) in [
        (
            "config file",
            "XDG_CONFIG_HOME",
            paths.config_file.display().to_string(),
        ),
        (
            "state directory",
            "XDG_STATE_HOME",
            paths.state_dir.display().to_string(),
        ),
    ] {
        let source = if std::env::var_os(var).is_some() {
            format!("environment override ({var})")
        } else {
            "default under HOME".to_string()
        };
        out.push(json!({ "setting": name, "value": path, "source": source, "note": null }));
    }
    out
}

/// The effective value of one managed setting and a note on it.
fn value_of(
    paths: &Paths,
    config: &config::Config,
    section: &str,
    key: &str,
) -> (String, Option<String>) {
    match (section, key) {
        ("hub", _) => (config.hub.log_level.as_str().to_string(), None),
        ("omp", _) => {
            let resolved = crate::omp::resolve(&config.omp.path);
            let note = resolved.map_or_else(
                || {
                    format!(
                        "unavailable: '{}' is not an executable file or on PATH",
                        config.omp.path
                    )
                },
                |p| format!("resolves to {}", p.display()),
            );
            (config.omp.path.clone(), Some(note))
        }
        ("telegram" | "slack", _) => relay_value(paths, config, section, key),
        ("fallback", _) => (
            config.fallback.on.clone().unwrap_or_else(|| "-".to_string()),
            Some("when OMP falls back: any error, usage-limit or except-usage-limit; unset keeps OMP's own setting".to_string()),
        ),
        ("fallback.chains", _) => (
            config
                .fallback
                .chains
                .get("default")
                .map_or_else(|| "-".to_string(), |c| c.join(",")),
            Some(
                "the models OMP may move to, in order, when the model in use runs out; never a reset, credits or overage"
                    .to_string(),
            ),
        ),
        ("lead", "model") => (
            config
                .lead
                .as_ref()
                .map_or_else(|| "-".to_string(), |l| l.model.clone()),
            Some(if config.lead.is_some() {
                "the standing lead session answers your messages".to_string()
            } else {
                "no lead: messages to Cataly wait until [lead] model is set".to_string()
            }),
        ),
        ("lead", "name") => (
            config
                .lead
                .as_ref()
                .and_then(|l| l.name.as_deref())
                .unwrap_or("Cataly")
                .to_string(),
            Some("how the assistant introduces itself in chat; the default keeps the built-in voice".to_string()),
        ),
        ("lead", "persona") => (
            config
                .lead
                .as_ref()
                .and_then(|l| l.persona.as_deref())
                .unwrap_or("-")
                .to_string(),
            Some("a few lines of personality guidance appended to the lead's instructions; unset keeps the built-in voice".to_string()),
        ),
        ("lead", _) => (
            config
                .lead
                .as_ref()
                .and_then(|l| l.cwd.as_ref())
                .map_or_else(|| "-".to_string(), |c| c.display().to_string()),
            Some("the lead's working folder; default your home folder".to_string()),
        ),
        _ => {
            let path = crate::jobs::owner::health::token_path(config, &paths.config_file);
            let note = match read_private(&path, 4096) {
                Ok(Some(_)) => "token present".to_string(),
                Ok(None) => "unavailable: no token in that file yet".to_string(),
                Err(e) => format!("unavailable: {e}"),
            };
            (path.display().to_string(), Some(note))
        }
    }
}

/// [`value_of`] for the Telegram and Slack settings.
fn relay_value(
    paths: &Paths,
    config: &config::Config,
    section: &str,
    key: &str,
) -> (String, Option<String>) {
    match (section, key) {
        (_, "token_file") => {
            let (configured, name) = if section == "telegram" {
                (config.telegram.token_file.as_ref(), "telegram-token")
            } else {
                (config.slack.token_file.as_ref(), "slack-tokens")
            };
            let path = crate::relay::intake::secret_path(configured, &paths.config_file, name);
            let note = match crate::relay::intake::read_secret(&path) {
                Ok(_) => "token present".to_string(),
                Err(e) => format!("unavailable: {e}"),
            };
            (path.display().to_string(), Some(note))
        }
        ("telegram", key) => {
            let value = match key {
                "owner" => config.telegram.owner,
                "group" => config.telegram.group,
                _ => config.telegram.topic,
            };
            let note = (key == "owner").then(|| {
                if config.telegram.intake() {
                    "intake runs".to_string()
                } else {
                    "intake is off until the owner is set".to_string()
                }
            });
            (
                value.map_or_else(|| "-".to_string(), |v| v.to_string()),
                note,
            )
        }
        ("slack", "role") => (
            match config.slack.role {
                crate::config::relays::SlackRole::App => "app".to_string(),
                crate::config::relays::SlackRole::Member => "member".to_string(),
            },
            Some(
                "app: the bot user sees only conversations it is in; member: the app's user \
                     token sees what that member sees and needs a paid seat"
                    .to_string(),
            ),
        ),
        _ => (
            config
                .slack
                .owner
                .clone()
                .unwrap_or_else(|| "-".to_string()),
            Some(if config.slack.intake() {
                "intake runs; only the owner's messages are admitted unless [slack] allow lists others"
                        .to_string()
            } else {
                "intake is off until the owner is set".to_string()
            }),
        ),
    }
}

/// Checks one managed value given on the command line and writes it into `text`.
fn set_value(
    text: &str,
    (section, key, flag): (&str, &str, &str),
    v: &str,
) -> Result<String, Failure> {
    if key == "log_level" && crate::log::Level::parse(v).is_none() {
        return Err(Failure::Usage(format!(
            "{flag}: expected error, warn, info or debug"
        )));
    }
    if key == "token_file" && !Path::new(v).is_absolute() {
        return Err(Failure::Usage(format!("{flag}: expected an absolute path")));
    }
    if let Some(why) = invalid(section, key, v.trim()) {
        return Err(Failure::Usage(format!("{flag}: {why}")));
    }
    let list = |items: &[&str]| {
        let quoted: Vec<String> = items.iter().map(|s| toml_string(s)).collect();
        format!("[{}]", quoted.join(", "))
    };
    if section == "fallback.chains" {
        return Ok(set_rendered(text, section, key, &list(&comma_list(v))));
    }
    Ok(set_key(text, section, key, v.trim()))
}

/// `on` or `off` from a flag such as `--approvals`.
fn switch(p: &Parsed, flag: &str) -> Result<Option<bool>, Failure> {
    p.value(flag)
        .map(|v| match v {
            "on" => Ok(true),
            "off" => Ok(false),
            _ => Err(Failure::Usage(format!("{flag}: expected on or off"))),
        })
        .transpose()
}

/// Whether the TOML text sets `key` in `[section]` (a dotted section names nested tables).
fn in_file(text: &str, section: &str, key: &str) -> bool {
    let table = toml::from_str::<toml::Table>(text).ok();
    let mut at = table.as_ref();
    for part in section.split('.') {
        at = at.and_then(|t| t.get(part)?.as_table());
    }
    at.and_then(|t| t.get(key)).is_some()
}

/// One line of the summary: what, its value, and whether this run changes it.
struct Item {
    what: &'static str,
    value: String,
    change: bool,
}

impl Item {
    fn new(what: &'static str, value: impl Into<String>, change: bool) -> Self {
        Self {
            what,
            value: value.into(),
            change,
        }
    }
}

/// What happens to the user service.
enum ServiceStep {
    Keep,
    Enable(Layout),
    Disable(Layout),
}

/// Everything one run decided before it changes anything.
struct Decided {
    text: String,
    discord: Option<Discord>,
    profile: Vec<&'static str>,
    home: Option<super::home::Home>,
    service: ServiceStep,
    items: Vec<Item>,
}

pub(super) fn run(p: &Parsed, paths: &Paths, as_json: bool) -> Result<(), Failure> {
    let flags = discord::Flags::parse(p).map_err(Failure::Usage)?;
    if p.value("--backup-repo")
        .is_some_and(|r| !crate::jobs::owner::backup::valid_repo(r))
    {
        return Err(Failure::Usage("--backup-repo: expected owner/name".into()));
    }
    let tightened = own_folders(paths)?;
    let (before, text) = load(paths)?;
    if let Some(expect) = p.value("--expect")
        && expect != before.digest()
    {
        return Err(Failure::Refused(format!(
            "{} changed since its preview (expected {expect}, found {}); your edit is kept, run setup again",
            paths.config_file.display(),
            before.digest()
        )));
    }
    let current = config::parse(&text).map_err(|e| {
        Failure::Refused(format!(
            "{} is not a valid config ({}); fix it first, cataly config check shows why",
            paths.config_file.display(),
            config::describe(&e)
        ))
    })?;
    let creating = before.bytes.is_none();
    let original = text;
    let text = managed(p, original.clone(), creating)?;
    let edited = (text != original).then(|| {
        if creating {
            "a new file".to_string()
        } else {
            let given: Vec<&str> = MANAGED
                .iter()
                .filter_map(|(_, _, f)| p.value(f).map(|_| *f))
                .collect();
            format!("{} as given", given.join(", "))
        }
    });
    // What the flags asked for, as the hub would read it.
    let planned = config::parse(&text).map_err(|e| {
        Failure::Usage(format!(
            "the result would not be a valid config: {}",
            config::describe(&e)
        ))
    })?;
    let term = Terminal::open(as_json);
    let discord = if uses_discord(p, &current) {
        match block_on(discord::discover(
            paths,
            &planned,
            term.as_ref(),
            as_json,
            &flags,
        )) {
            Ok(d) => Some(d),
            Err((report, next)) => {
                if as_json {
                    out::json(&json!({ "discord": report }));
                }
                return Err(Failure::Refused(next));
            }
        }
    } else {
        None
    };
    let mut decided = decide(p, paths, &planned, text, discord)?;
    if let Some(what) = edited {
        decided.items.insert(0, Item::new("config", what, true));
    }
    if !tightened.is_empty() {
        let list: Vec<String> = tightened.iter().map(|d| d.display().to_string()).collect();
        decided.items.push(Item::new(
            "folders",
            format!("{} made owner-only (0700)", list.join(", ")),
            false,
        ));
    }
    let pending = decided.items.iter().any(|i| i.change);
    if !as_json {
        print_summary(paths, &decided.items, creating, pending);
    }
    let go = pending
        && (p.flag("--yes") || term.as_ref().is_some_and(|t| t.yes("Apply these changes?")));
    let mut notes = Vec::new();
    let mut written = before.bytes.clone().unwrap_or_default();
    if go {
        written = apply(paths, &before, &planned, &mut decided, &mut notes)?.into_bytes();
    } else if pending && !as_json {
        out::line("Nothing changed. Run `cataly setup --yes` to apply it.");
    }
    if as_json {
        out::json(&report(paths, &before, &written, go, &decided, &notes));
    } else {
        for n in &notes {
            out::line(n);
        }
    }
    Ok(())
}

/// Cataly's own folders: the config folder, its `secrets` and the state folder, made owner-only.
/// Returns the ones that were open to group or others and were tightened.
fn own_folders(paths: &Paths) -> Result<Vec<PathBuf>, Failure> {
    let config_dir = paths.config_file.parent().unwrap_or(Path::new("/"));
    let mut tightened = Vec::new();
    for dir in [
        config_dir.to_path_buf(),
        config_dir.join("secrets"),
        paths.state_dir.clone(),
    ] {
        if crate::sys::fs::claim_private_dir(&dir).map_err(|e| Failure::Refused(e.to_string()))? {
            tightened.push(dir);
        }
    }
    Ok(tightened)
}

/// Discord is set up unless the owner uses only Telegram or Slack.
fn uses_discord(p: &Parsed, config: &Config) -> bool {
    let d = &config.discord;
    let discord = d.owner.is_some()
        || d.guild.is_some()
        || !d.channels.is_empty()
        || p.value("--guild").is_some()
        || p.value("--owner").is_some()
        || p.value("--discord-token-file").is_some();
    let other = config.telegram.owner.is_some()
        || config.slack.owner.is_some()
        || p.value("--telegram-owner").is_some()
        || p.value("--slack-owner").is_some();
    discord || !other
}

/// Every default and flag applied to the config text, and the steps beyond it.
fn decide(
    p: &Parsed,
    paths: &Paths,
    planned: &Config,
    mut text: String,
    discord: Option<Discord>,
) -> Result<Decided, Failure> {
    let mut items = Vec::new();
    let mut profile = Vec::new();
    if let Some(d) = &discord {
        let owner_new =
            planned.discord.owner != Some(d.owner) || planned.discord.guild != Some(d.guild);
        items.push(Item::new(
            "discord",
            format!(
                "bot {} in {}; owner {} ({})",
                d.bot, d.server, d.owner, d.owner_source
            ),
            owner_new,
        ));
        let shown = |name: &str, id: Option<crate::relay::discord::Snowflake>| {
            id.map_or_else(
                || format!("#{name} (to create)"),
                |id| format!("#{name} {id}"),
            )
        };
        let settled = d.grouped()
            && match (d.lead, d.ops) {
                (Some(lead), Some(ops)) => {
                    discord::config_text(planned, String::new(), d, lead, ops).is_empty()
                }
                _ => false,
            };
        items.push(Item::new(
            "channels",
            format!(
                "{} for the lead, {} for job notices",
                shown(discord::LEAD, d.lead),
                shown(discord::OPS, d.ops)
            ),
            !settled,
        ));
        let flag = switch(p, "--approvals")?;
        let set = in_file(&text, "discord", "remote_approvals");
        let on = flag.unwrap_or(if set {
            planned.discord.remote_approvals
        } else {
            true
        });
        let change = !set || on != planned.discord.remote_approvals;
        if change {
            text = set_rendered(&text, "discord", "remote_approvals", &on.to_string());
        }
        items.push(Item::new(
            "approvals",
            if on {
                "on: OMP's permission requests get buttons; only your presses count"
            } else {
                "off: permission requests wait for `cataly lead answer`"
            },
            change,
        ));
        let force = p.flag("--profile");
        if planned.discord.profile || force {
            let plan = d.profile_plan(&paths.state_dir, force);
            items.push(Item::new("profile", plan.summary(), !plan.set.is_empty()));
            profile = plan.set;
        }
    }
    text = lead(planned, text, &mut items);
    let (text, home) = backup(p, paths, planned, text, &mut items)?;
    let text = jobs(planned, text, discord.is_some(), &mut items);
    let (text, service) = service(p, planned, text, &mut items)?;
    Ok(Decided {
        text,
        discord,
        profile,
        home,
        service,
        items,
    })
}

/// The lead's model: the flag, else the config's, else the one OMP starts with.
fn lead(planned: &Config, mut text: String, items: &mut Vec<Item>) -> String {
    if let Some(l) = &planned.lead {
        items.push(Item::new("lead", l.model.clone(), false));
        return text;
    }
    let offered = crate::omp::resolve(&planned.omp.path)
        .and_then(|omp| block_on(crate::omp::usage::default_model(&omp)));
    match offered {
        Some(model) => {
            text = set_key(&text, "lead", "model", &model);
            items.push(Item::new(
                "lead",
                format!("{model} (OMP's default model)"),
                true,
            ));
        }
        None => items.push(Item::new(
            "lead",
            "none: OMP names no default model; messages wait until `cataly setup --lead-model provider/id`",
            false,
        )),
    }
    text
}

/// The home backup: kept as configured, switched off or on by `--backup`, or planned with `gh`.
/// Turned off before it existed, it is remembered as `[setup] backup = false`, so a plain re-run
/// does not offer it again; `--backup on` (or `--backup-repo`) plans it and clears the mark.
fn backup(
    p: &Parsed,
    paths: &Paths,
    planned: &Config,
    mut text: String,
    items: &mut Vec<Item>,
) -> Result<(String, Option<super::home::Home>), Failure> {
    let flag = switch(p, "--backup")?;
    let repo = p.value("--backup-repo");
    let section = format!("jobs.{}", super::home::JOB);
    let job = planned.jobs.get(super::home::JOB);
    match (job, flag, repo) {
        (Some(j), Some(false), _) if j.enabled => {
            text = set_rendered(&text, &section, "enabled", "false");
            items.push(Item::new("backup", "off (job home switched off)", true));
        }
        (None, Some(false), _) if planned.setup.backup => {
            text = set_rendered(&text, "setup", "backup", "false");
            items.push(Item::new("backup", "off (remembered)", true));
        }
        (_, Some(false), _) => items.push(Item::new("backup", "off", false)),
        (Some(j), Some(true), None) if !j.enabled => {
            text = set_rendered(&text, &section, "enabled", "true");
            items.push(Item::new("backup", "on (job home switched on)", true));
        }
        (Some(j), _, None) => items.push(Item::new(
            "backup",
            if j.enabled {
                "on (job home)"
            } else {
                "off (job home is switched off)"
            },
            false,
        )),
        (None, None, None) if !planned.setup.backup => items.push(Item::new(
            "backup",
            "off (you turned it off; `cataly setup --backup on` turns it on)",
            false,
        )),
        (_, asked, repo) => match block_on(super::home::plan(repo, paths)) {
            Ok(h) => {
                if !planned.setup.backup {
                    text = set_rendered(&text, "setup", "backup", "true");
                }
                text = h.config(&text);
                items.push(Item::new("backup", h.summary(), true));
                return Ok((text, Some(h)));
            }
            Err(e) if asked == Some(true) || repo.is_some() => return Err(Failure::Refused(e)),
            Err(e) => items.push(Item::new(
                "backup",
                format!("off: {e}; later `cataly setup --backup on`"),
                false,
            )),
        },
    }
    Ok((text, None))
}

/// The health and pressure jobs, each named after its kind, added when no job of that kind exists.
fn jobs(planned: &Config, mut text: String, notices: bool, items: &mut Vec<Item>) -> String {
    let mut added = false;
    for kind in JOBS {
        if planned.jobs.values().any(|j| j.kind() == kind) || planned.jobs.contains_key(kind) {
            continue;
        }
        let section = format!("jobs.{kind}");
        text = set_key(&text, &section, "kind", kind);
        if notices {
            let ops = toml_string(discord::OPS);
            text = set_rendered(&text, &section, "destinations", &format!("[{ops}]"));
        }
        added = true;
    }
    items.push(Item::new(
        "jobs",
        format!("{} with their defaults", JOBS.join(", ")),
        added,
    ));
    text
}

/// The user service: kept, enabled (with `[omp] path` pinned, since the service's PATH is not the
/// shell's) or, with `--service off`, removed.
fn service(
    p: &Parsed,
    planned: &Config,
    mut text: String,
    items: &mut Vec<Item>,
) -> Result<(String, ServiceStep), Failure> {
    let flag = switch(p, "--service")?;
    let layout = Layout::of_running().map_err(Failure::Refused)?;
    let exists = layout.service_marker().exists();
    let installed = layout.installed();
    let manager = if cfg!(target_os = "macos") {
        "launchd agent"
    } else {
        "systemd user service"
    };
    let step = match (flag, exists, installed) {
        (Some(false), true, _) => {
            items.push(Item::new(
                "service",
                format!("off ({manager} to remove)"),
                true,
            ));
            ServiceStep::Disable(layout)
        }
        (Some(false), false, _) => {
            items.push(Item::new("service", "off", false));
            ServiceStep::Keep
        }
        (_, true, _) => {
            items.push(Item::new("service", format!("on ({manager})"), false));
            ServiceStep::Keep
        }
        (_, false, true) => {
            if let Some(omp) = crate::omp::resolve(&planned.omp.path)
                && !Path::new(&planned.omp.path).is_absolute()
            {
                text = set_key(&text, "omp", "path", &omp.display().to_string());
            }
            items.push(Item::new(
                "service",
                format!("{manager}, to enable and start"),
                true,
            ));
            ServiceStep::Enable(layout)
        }
        (Some(true), false, false) => {
            return Err(Failure::Refused(
                "install Cataly first; the service runs the installed command".into(),
            ));
        }
        (None, false, false) => {
            items.push(Item::new(
                "service",
                "off: this cataly is not an installed release; install it with install.sh, npm or \
                 Bun, then `cataly setup`",
                false,
            ));
            ServiceStep::Keep
        }
    };
    Ok((text, step))
}

/// The one short summary.
fn print_summary(paths: &Paths, items: &[Item], creating: bool, pending: bool) {
    let state = if creating { " (new)" } else { "" };
    out::line(&format!(
        "Cataly setup: {}{state}",
        paths.config_file.display()
    ));
    for i in items {
        let mark = if i.change { "+" } else { " " };
        out::line(&format!("{mark} {:<10} {}", i.what, i.value));
    }
    if pending {
        out::line("+ marks what this run changes.");
    } else {
        out::line("Everything is set; nothing to change.");
    }
    out::line(
        "Change later with cataly setup --lead-model provider/id, --approvals off, --backup off, \
         --service off, --profile, or by editing the file.",
    );
}

/// Carries out what was decided, in order: the Discord channels, the profile, the home backup, the
/// config file, the service, and a reload of a running hub. Returns the config text written.
fn apply(
    paths: &Paths,
    before: &Snapshot,
    planned: &Config,
    decided: &mut Decided,
    notes: &mut Vec<String>,
) -> Result<String, Failure> {
    let mut text = decided.text.clone();
    if let Some(d) = &mut decided.discord {
        let (lead, ops) = block_on(d.create_missing()).map_err(Failure::Refused)?;
        text = discord::config_text(planned, text, d, lead, ops);
        if !decided.profile.is_empty() {
            match block_on(d.set_profile(&paths.state_dir, &decided.profile)) {
                Ok(()) => notes.push(format!("bot {} set", decided.profile.join(" and "))),
                Err(e) => notes.push(format!(
                    "bot profile not set ({e}); `cataly setup --profile` tries again"
                )),
            }
        }
    }
    if let Some(h) = &decided.home {
        block_on(h.apply()).map_err(Failure::Refused)?;
    }
    config::parse(&text).map_err(|e| {
        Failure::Refused(format!(
            "the result would not be a valid config: {}",
            config::describe(&e)
        ))
    })?;
    let changed = before.bytes.as_deref() != Some(text.as_bytes());
    if changed {
        publish(&paths.config_file, before, text.as_bytes())?;
        notes.push(format!("written: {}", paths.config_file.display()));
    }
    match &decided.service {
        ServiceStep::Enable(layout) => {
            let config = config::parse(&text).unwrap_or_default();
            let (file, more) = block_on(super::install::enable_service(layout, paths, &config))
                .map_err(Failure::Refused)?;
            notes.push(format!("service written to {} and started", file.display()));
            notes.extend(more.into_iter().map(|n| format!("  {n}")));
            return Ok(text);
        }
        ServiceStep::Disable(layout) => {
            if let Some(file) =
                block_on(crate::sys::service::disable(layout)).map_err(Failure::Refused)?
            {
                notes.push(format!("service stopped and {} removed", file.display()));
            }
        }
        ServiceStep::Keep => {}
    }
    if changed && let Ok(mut hub) = super::client::Client::connect(&paths.socket) {
        match hub.call(method::CONFIG_RELOAD, json!({}), CALL_TIMEOUT) {
            Ok(_) => notes.push("the running hub applied it".into()),
            Err(e) => notes.push(format!(
                "the running hub did not apply it ({e}); run `cataly config reload`"
            )),
        }
    }
    Ok(text)
}

/// The `--json` report.
fn report(
    paths: &Paths,
    before: &Snapshot,
    written: &[u8],
    applied: bool,
    decided: &Decided,
    notes: &[String],
) -> Value {
    let text = if applied {
        String::from_utf8_lossy(written).into_owned()
    } else {
        decided.text.clone()
    };
    let after = sha256_hex(text.as_bytes());
    let action = if before.bytes.is_none() {
        "create"
    } else if after == before.digest() {
        "keep"
    } else {
        "update"
    };
    let hub = super::client::Client::connect(&paths.socket)
        .ok()
        .and_then(|mut c| c.call(method::STATUS, json!({}), CALL_TIMEOUT).ok())
        .and_then(|v| serde_json::from_value::<Status>(v).ok());
    let summary: Vec<Value> = decided
        .items
        .iter()
        .map(|i| json!({ "item": i.what, "value": i.value, "change": i.change }))
        .collect();
    json!({
        "file": paths.config_file.display().to_string(),
        "action": action,
        "applied": applied,
        "before": before.digest(),
        "after": after,
        "valid": config::parse(&text)
            .map_or_else(|e| Value::String(config::describe(&e)), |_| Value::Bool(true)),
        "summary": summary,
        "discord": decided.discord.as_ref().map(|d| d.found.report(None)),
        "backup": decided.home.as_ref().map(super::home::Home::report),
        "sources": sources(paths, &text, hub.as_ref(), &after),
        "notes": notes,
    })
}

/// The snapshot of the config file and its text (a new file's header when there is none).
pub(super) fn load(paths: &Paths) -> Result<(Snapshot, String), Failure> {
    let path = &paths.config_file;
    let before = snapshot(path).map_err(Failure::Refused)?;
    let text = match &before.bytes {
        Some(b) => String::from_utf8(b.clone())
            .map_err(|_| Failure::Refused(format!("{} is not UTF-8", path.display())))?,
        None => NEW_FILE.to_string(),
    };
    Ok((before, text))
}

/// Writes one setting outside a setup run (`cataly service enable` pins `[omp] path`), under the same
/// snapshot, validity, atomic-write and read-back rules.
pub(super) fn write_one(
    paths: &Paths,
    section: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let refused = |f: Failure| match f {
        Failure::Refused(m) | Failure::Usage(m) | Failure::Status(_, m) => m,
        Failure::Client(e) => e.to_string(),
    };
    let (before, text) = load(paths).map_err(refused)?;
    let text = set_key(&text, section, key, value);
    config::parse(&text).map_err(|e| {
        format!(
            "the result would not be a valid config: {}",
            config::describe(&e)
        )
    })?;
    publish(&paths.config_file, &before, text.as_bytes()).map_err(refused)
}

/// Sets the managed settings the flags name (a new file gets the ones OMP and the hub need).
pub(super) fn managed(p: &Parsed, mut text: String, creating: bool) -> Result<String, Failure> {
    for (section, key, flag) in MANAGED {
        let value = match (p.value(flag), creating, section) {
            (Some(v), _, _) => Some(v.to_string()),
            // A new file gets the managed settings OMP and the hub need, with their defaults.
            (None, true, "hub") => Some("info".to_string()),
            (None, true, "omp") => Some("omp".to_string()),
            _ => None,
        };
        if let Some(v) = value {
            text = set_value(&text, (section, key, flag), &v)?;
        }
    }
    Ok(text)
}

/// Re-checks the snapshot, writes atomically (never overwriting a file that appeared meanwhile), and
/// reads the result back.
fn publish(path: &Path, before: &Snapshot, bytes: &[u8]) -> Result<(), Failure> {
    let now = snapshot(path).map_err(Failure::Refused)?;
    if now != *before {
        return Err(Failure::Refused(format!(
            "{} changed since its snapshot; your edit is kept, run setup again",
            path.display()
        )));
    }
    if let Some(dir) = path.parent() {
        crate::sys::fs::ensure_private_dir(dir).map_err(|e| Failure::Refused(e.to_string()))?;
    }
    let written = if before.bytes.is_none() {
        create_atomic(path, bytes)
    } else {
        write_atomic(path, bytes)
    };
    written.map_err(|e| Failure::Refused(e.to_string()))?;
    match read_private(path, CONFIG_MAX) {
        Ok(Some(back)) if back == bytes => Ok(()),
        _ => Err(Failure::Refused(format!(
            "{} did not read back as written",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_key_replaces_adds_and_keeps_the_rest() {
        let text = "# mine\n[hub]\nlog_level = \"warn\" # loud\n\n[jobs.x]\nkind = \"once\"\n";
        let out = set_key(text, "hub", "log_level", "debug");
        assert_eq!(
            out,
            "# mine\n[hub]\nlog_level = \"debug\"\n\n[jobs.x]\nkind = \"once\"\n"
        );
        let out = set_key(&out, "omp", "path", "/opt/omp \"x\"");
        assert!(
            out.ends_with("[omp]\npath = \"/opt/omp \\\"x\\\"\"\n"),
            "{out}"
        );
        let out = set_key("[omp]\n# keep\n\n[hub]\n", "omp", "path", "omp");
        assert_eq!(out, "[omp]\n# keep\npath = \"omp\"\n\n[hub]\n");
        assert!(config::parse(&set_key(NEW_FILE, "hub", "log_level", "info")).is_ok());
    }

    #[test]
    fn lead_name_and_persona_flags_write_valid_keys() {
        let base = "[lead]\nmodel = \"p/m\"\n";
        let named = set_key(base, "lead", "name", "Mi");
        let parsed = config::parse(&named).unwrap();
        assert_eq!(parsed.lead.as_ref().unwrap().name.as_deref(), Some("Mi"));
        let both = set_key(&named, "lead", "persona", "dry wit");
        let parsed = config::parse(&both).unwrap();
        let lead = parsed.lead.unwrap();
        assert_eq!(lead.name.as_deref(), Some("Mi"));
        assert_eq!(lead.persona.as_deref(), Some("dry wit"));
        assert_eq!(invalid("lead", "name", "anything goes"), None);
    }

    #[test]
    fn snapshot_refuses_a_group_readable_file_like_the_hub() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("cataly-setup-perm-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("config.toml");
        assert!(std::fs::write(&path, "[hub]\n").is_ok());
        assert!(std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).is_ok());
        let err = snapshot(&path).err().unwrap_or_default();
        assert!(err.contains("chmod go="), "{err}");
        assert!(read_private(&path, CONFIG_MAX).is_err());
        assert!(std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).is_ok());
        assert!(snapshot(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

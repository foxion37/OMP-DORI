//! `[sessions]`, `[lead]` and `[fallback]` (HOST req. 17-18, 21, 89; DESIGN 4.2, 9.2): the session cap,
//! the provider credentials and extra flags OMP children get, the owner's spend-offer phrases, the
//! standing lead, and the model fallback OMP may apply.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::{ConfigError, Section};
use crate::omp::transcript::model_selector;

/// Live OMP children allowed by default (HOST req. 89).
const DEFAULT_CAP: u32 = 8;
/// Thinking levels OMP accepts on its command line.
pub(crate) const THINKING: [&str; 8] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];
/// `retry.fallbackOn` values.
pub(crate) const FALLBACK_ON: [&str; 3] = ["any", "usage-limit", "except-usage-limit"];
/// Flags the hub sets itself or that would change what the hub controls (HOST req. 18-19).
const RESERVED_FLAGS: [&str; 24] = [
    "mode",
    "session-dir",
    "resume",
    "r",
    "continue",
    "c",
    "restore",
    "fork",
    "print",
    "p",
    "goal",
    "plan",
    "approval-mode",
    "auto-approve",
    "yolo",
    "cwd",
    "config",
    "model",
    "thinking",
    "append-system-prompt",
    "system-prompt",
    "tools",
    "max-cost",
    "no-session",
];

/// `[sessions]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionSettings {
    /// Live OMP children at most, roles included (1-32).
    pub(crate) cap: u32,
    /// Environment variable names passed from the hub to OMP children (provider credentials).
    pub(crate) credentials: Vec<String>,
    /// Owner-approved extra flags, each `--name` or `--name=value`.
    pub(crate) extra_flags: Vec<String>,
    /// Owner phrases that mark a dialog as a spend offer, besides the built-in ones.
    pub(crate) spend_phrases: Vec<String>,
    /// The runtime of new sessions (HOST-30): `headless` (default) or `tern`.
    pub(crate) runtime: RuntimeKind,
    /// The Tern executable: an absolute path or a name on `PATH` (HOST req. 92).
    pub(crate) tern: String,
    /// The Tern session new blocks open in; absent: the session shown (HOST req. 93).
    pub(crate) tern_session: Option<String>,
}

/// Which runtime starts a session (DESIGN 4.1). New sessions take the config's; a stored session
/// keeps the one it was started with (HOST req. 91).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeKind {
    #[default]
    Headless,
    Tern,
}

impl RuntimeKind {
    /// The name stored with each session (`headless`, `tern`).
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Headless => "headless",
            Self::Tern => "tern",
        }
    }

    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "headless" => Some(Self::Headless),
            "tern" => Some(Self::Tern),
            _ => None,
        }
    }
}

impl Default for SessionSettings {
    fn default() -> Self {
        Self {
            cap: DEFAULT_CAP,
            credentials: Vec::new(),
            extra_flags: Vec::new(),
            spend_phrases: Vec::new(),
            runtime: RuntimeKind::Headless,
            tern: "tern".into(),
            tern_session: None,
        }
    }
}

/// `[lead]`: present means the hub keeps one standing lead session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeadSettings {
    /// `provider/id`.
    pub(crate) model: String,
    pub(crate) thinking: Option<String>,
    /// Working directory; default the home directory.
    pub(crate) cwd: Option<PathBuf>,
    /// The lead must resume exactly this OMP session (HOST req. 82).
    pub(crate) session_id: Option<String>,
    /// Owner-only file with the role instructions (`--append-system-prompt`).
    pub(crate) instructions: Option<PathBuf>,
    /// The assistant's name in chat; default "Cataly" reproduces the built-in voice.
    pub(crate) name: Option<String>,
    /// A few lines of extra personality guidance appended to the lead's instructions.
    pub(crate) persona: Option<String>,
    /// Start the lead when the hub starts (default true).
    pub(crate) autostart: bool,
}

/// `[fallback]`: carried into the overlay only when set (DESIGN 9.2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FallbackSettings {
    /// `retry.fallbackOn`.
    pub(crate) on: Option<String>,
    /// `retry.fallbackChains`: role -> ordered `provider/id` list.
    pub(crate) chains: BTreeMap<String, Vec<String>>,
}

fn absolute(
    errors: &mut Vec<ConfigError>,
    s: &Section<'_>,
    key: &str,
    value: &str,
) -> Option<PathBuf> {
    if Path::new(value).is_absolute() {
        Some(PathBuf::from(value))
    } else {
        errors.push(s.error(key, "must be an absolute path"));
        None
    }
}

fn env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !name.starts_with("CATALY_")
}

/// Why an extra flag is refused, if it is.
pub(crate) fn extra_flag_error(flag: &str) -> Option<String> {
    let Some(body) = flag.strip_prefix("--") else {
        return Some(format!(
            "'{flag}': only --name or --name=value flags are accepted (no positional text or short flags)"
        ));
    };
    let name = body.split_once('=').map_or(body, |(n, _)| n);
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Some(format!("'{flag}' is not a flag"));
    }
    if RESERVED_FLAGS.contains(&name) {
        return Some(format!(
            "'--{name}' is set by the hub and may not be overridden"
        ));
    }
    if name == "extension" || name.starts_with("approval") || name.contains("approve") {
        return Some(format!("'--{name}' is not allowed for hosted sessions"));
    }
    None
}

/// `runtime`, `tern` and `tern_session` of `[sessions]` (HOST-30, HOST req. 92-93).
fn runtime(errors: &mut Vec<ConfigError>, s: &mut Section<'_>, sessions: &mut SessionSettings) {
    match s.string(errors, "runtime").map(RuntimeKind::from_name) {
        None => {}
        Some(Some(kind)) => sessions.runtime = kind,
        Some(None) => errors.push(s.error("runtime", "expected headless or tern")),
    }
    if let Some(tern) = s.string(errors, "tern") {
        if tern.trim().is_empty() {
            errors.push(s.error("tern", "must name the Tern executable"));
        } else {
            sessions.tern = tern.to_string();
        }
    }
    sessions.tern_session = s
        .string(errors, "tern_session")
        .filter(|n| !n.trim().is_empty())
        .map(str::to_string);
}

pub(super) fn parse(
    errors: &mut Vec<ConfigError>,
    root: &mut Section<'_>,
    sessions: &mut SessionSettings,
    lead: &mut Option<LeadSettings>,
    fallback: &mut FallbackSettings,
) {
    if let Some(mut s) = root.table(errors, "sessions") {
        if let Some(cap) = s.integer(errors, "cap", 1, 32) {
            sessions.cap = u32::try_from(cap).unwrap_or(DEFAULT_CAP);
        }
        for name in s.strings(errors, "credentials").unwrap_or_default() {
            if env_name(&name) {
                sessions.credentials.push(name);
            } else {
                errors.push(s.error(
                    "credentials",
                    &format!("'{name}' is not an environment variable name Cataly passes on"),
                ));
            }
        }
        for flag in s.strings(errors, "extra_flags").unwrap_or_default() {
            match extra_flag_error(&flag) {
                None => sessions.extra_flags.push(flag),
                Some(e) => errors.push(s.error("extra_flags", &e)),
            }
        }
        sessions.spend_phrases = s
            .strings(errors, "spend_phrases")
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_lowercase())
            .filter(|p| !p.trim().is_empty())
            .collect();
        runtime(errors, &mut s, sessions);
        s.finish(errors);
    }
    if let Some(l) = root.table(errors, "lead") {
        parse_lead(errors, l, lead);
    }
    if let Some(mut f) = root.table(errors, "fallback") {
        if let Some(on) = f.string(errors, "on") {
            if FALLBACK_ON.contains(&on) {
                fallback.on = Some(on.to_string());
            } else {
                errors.push(f.error("on", &format!("expected one of {}", FALLBACK_ON.join(", "))));
            }
        }
        if let Some(mut chains) = f.table(errors, "chains") {
            for (role, value) in chains.entries() {
                let path = chains.child(role);
                let list: Option<Vec<String>> = value
                    .as_array()
                    .and_then(|a| a.iter().map(|v| v.as_str().map(str::to_string)).collect());
                match list {
                    Some(list) if list.iter().all(|m| model_selector(m)) => {
                        fallback.chains.insert(role.clone(), list);
                    }
                    _ => errors.push(ConfigError {
                        path,
                        message: "expected a list of provider/id models".into(),
                    }),
                }
            }
        }
        f.finish(errors);
    }
}

/// The `[lead]` table: the model the standing lead runs on, its working folder and persona (HOST
/// req. 17-18). Blank `name`/`persona` behave as unset; unknown keys fail the load.
fn parse_lead(errors: &mut Vec<ConfigError>, mut l: Section<'_>, lead: &mut Option<LeadSettings>) {
    let model = l.required_string(errors, "model").map(str::to_string);
    if let Some(m) = &model
        && !model_selector(m)
    {
        errors.push(l.error("model", "expected provider/id"));
    }
    let thinking = l.string(errors, "thinking").map(str::to_string);
    if let Some(t) = &thinking
        && !THINKING.contains(&t.as_str())
    {
        errors.push(l.error(
            "thinking",
            &format!("expected one of {}", THINKING.join(", ")),
        ));
    }
    let cwd = l
        .string(errors, "cwd")
        .and_then(|v| absolute(errors, &l, "cwd", v));
    let instructions = l
        .string(errors, "instructions")
        .and_then(|v| absolute(errors, &l, "instructions", v));
    let session_id = l
        .string(errors, "session_id")
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string);
    let autostart = l.bool(errors, "autostart").unwrap_or(true);
    let name = l
        .string(errors, "name")
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string);
    let persona = l
        .string(errors, "persona")
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string);
    l.finish(errors);
    if let Some(model) = model.filter(|m| model_selector(m)) {
        *lead = Some(LeadSettings {
            model,
            thinking,
            cwd,
            session_id,
            instructions,
            name,
            persona,
            autostart,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_flags_cannot_take_over_the_launch() {
        assert_eq!(extra_flag_error("--no-skills"), None);
        assert_eq!(extra_flag_error("--service-tier=flex"), None);
        for bad in [
            "--mode=rpc",
            "--resume",
            "-r",
            "hello",
            "--session-dir=/x",
            "--approval-mode=yolo",
            "--config=x",
            "--model=a/b",
            "--extension=x.ts",
            "--auto-approve",
            "--",
        ] {
            assert!(extra_flag_error(bad).is_some(), "{bad}");
        }
    }

    #[test]
    fn sections_parse_and_name_their_errors() {
        let config = crate::config::parse(
            "[sessions]\ncap = 4\ncredentials = [\"ANTHROPIC_API_KEY\"]\nspend_phrases = [\"Top Up\"]\n\
             [lead]\nmodel = \"p/m\"\nthinking = \"low\"\n\
             [fallback]\non = \"usage-limit\"\n[fallback.chains]\ndefault = [\"p/n\"]\n",
        )
        .unwrap();
        assert_eq!(config.sessions.cap, 4);
        assert_eq!(config.sessions.spend_phrases, ["top up"]);
        assert_eq!(config.lead.as_ref().unwrap().model, "p/m");
        assert_eq!(config.fallback.chains["default"], ["p/n"]);
        let errors = crate::config::parse(
            "[sessions]\ncap = 99\ncredentials = [\"CATALY_X\"]\n[lead]\nmodel = \"bad\"\n\
             [fallback]\non = \"never\"\n[fallback.chains]\ndefault = [\"x\"]\n",
        )
        .unwrap_err();
        let paths: Vec<&str> = errors.iter().map(|e| e.path.as_str()).collect();
        for p in [
            "sessions.cap",
            "sessions.credentials",
            "lead.model",
            "fallback.on",
            "fallback.chains.default",
        ] {
            assert!(paths.contains(&p), "{p}: {paths:?}");
        }
    }

    #[test]
    fn lead_name_and_persona_parse_with_their_defaults() {
        let bare = crate::config::parse("[lead]\nmodel = \"p/m\"\n").unwrap();
        let lead = bare.lead.unwrap();
        assert_eq!(lead.name, None);
        assert_eq!(lead.persona, None);
        let named = crate::config::parse(
            "[lead]\nmodel = \"p/m\"\nname = \"Mi\"\npersona = \"dry wit, short sentences\"\n",
        )
        .unwrap()
        .lead
        .unwrap();
        assert_eq!(named.name.as_deref(), Some("Mi"));
        assert_eq!(named.persona.as_deref(), Some("dry wit, short sentences"));
        // Blank values behave as unset; unknown keys are still refused.
        let blank = crate::config::parse("[lead]\nmodel = \"p/m\"\nname = \"  \"\n").unwrap();
        assert_eq!(blank.lead.unwrap().name, None);
        let errors = crate::config::parse("[lead]\nmodel = \"p/m\"\nunknown = 1\n").unwrap_err();
        assert!(errors.iter().any(|e| e.path.starts_with("lead")));
    }
}

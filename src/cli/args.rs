//! The in-house argument parser (COORD-53): a verb path, then flags. A value flag always takes the next
//! word verbatim, even when it starts with dashes; a value flag at the end, an unknown flag, a missing
//! or extra argument and an empty argument are refused with one line. `--help` prints usage and runs
//! nothing.

use std::fmt::Write as _;

/// One command the CLI knows.
#[derive(Debug)]
pub(crate) struct Spec {
    pub(crate) path: &'static [&'static str],
    pub(crate) args: &'static [&'static str],
    pub(crate) flags: &'static [&'static str],
    pub(crate) values: &'static [&'static str],
    pub(crate) summary: &'static str,
}

pub(crate) const COMMANDS: [Spec; 55] = [
    Spec {
        path: &["slot"],
        args: &["name"],
        flags: &[],
        values: &["--lane", "--priority", "--timeout"],
        summary: "wait for the named slot, then run the command after '--' and end with its exit status",
    },
    Spec {
        path: &["lane"],
        args: &["op"],
        flags: &["--json"],
        values: &["--params"],
        summary: "one lane operation (open, list, board, pause, resume, park, abandon, claim, object, close, \
                  reopen, send, release, read, interrupt, model, answer, grant, drift, spend); --params '<json>'",
    },
    Spec {
        path: &["hub"],
        args: &[],
        flags: &[],
        values: &[],
        summary: "run the hub in the foreground",
    },
    Spec {
        path: &["status"],
        args: &[],
        flags: &["--json", "--install"],
        values: &["--prefix"],
        summary: "show the hub's state; --install checks the installation instead (links, records, hashes)",
    },
    Spec {
        path: &["events"],
        args: &[],
        flags: &["--json", "--follow"],
        values: &["--since", "--after", "--limit"],
        summary: "show events; --since 10m|<instant>, --after <id>, --follow to keep reading",
    },
    Spec {
        path: &["stats"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "memory and latency figures",
    },
    Spec {
        path: &["job", "list"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "list jobs and their state",
    },
    Spec {
        path: &["job", "run"],
        args: &["name"],
        flags: &["--json"],
        values: &[],
        summary: "run one dry tick of a job now and show its events",
    },
    Spec {
        path: &["job", "enable"],
        args: &["name"],
        flags: &["--json", "--ack"],
        values: &[],
        summary: "resume a held job (--ack after a broken-off run)",
    },
    Spec {
        path: &["job", "disable"],
        args: &["name"],
        flags: &["--json"],
        values: &[],
        summary: "put a job on hold",
    },
    Spec {
        path: &["config", "check"],
        args: &[],
        flags: &["--json"],
        values: &["--file"],
        summary: "validate the config file (or --file <path>) without applying it",
    },
    Spec {
        path: &["config", "reload"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "apply the config file; an invalid file is refused and the running config kept",
    },
    Spec {
        path: &["version"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "version, commit, target, minimum OMP and bridge protocol; needs no config",
    },
    Spec {
        path: &["extension"],
        args: &[],
        flags: &[],
        values: &[],
        summary: "print the bridge file this binary installs (the release's extension asset)",
    },
    Spec {
        path: &["install"],
        args: &[],
        flags: &[],
        values: &["--from", "--prefix"],
        summary: "install from a folder of release assets (--from); install.sh runs this",
    },
    Spec {
        path: &["update"],
        args: &[],
        flags: &["--no-restart"],
        values: &["--from", "--tag", "--prefix"],
        summary: "install the latest stable release (or --tag, or --from <folder>) and restart a running hub on it; --no-restart leaves the hub on the old version until it restarts",
    },
    Spec {
        path: &["rollback"],
        args: &[],
        flags: &["--no-restart"],
        values: &["--expect", "--prefix"],
        summary: "switch back to the previous version (--expect <version> to assert which) and restart a running hub on it; --no-restart leaves the hub as it is",
    },
    Spec {
        path: &["check"],
        args: &[],
        flags: &["--json"],
        values: &["--tag"],
        summary: "compare the latest stable release (or --tag) with the installed version; changes nothing",
    },
    Spec {
        path: &["uninstall"],
        args: &[],
        flags: &[],
        values: &["--prefix"],
        summary: "remove the program folder and both links; config and state are kept",
    },
    Spec {
        path: &["service", "enable"],
        args: &[],
        flags: &[],
        values: &[],
        summary: "write and start a user service that runs the hub (systemd user unit or launchd agent)",
    },
    Spec {
        path: &["service", "disable"],
        args: &[],
        flags: &[],
        values: &[],
        summary: "stop and remove the user service Cataly created",
    },
    Spec {
        path: &["service", "refresh"],
        args: &[],
        flags: &[],
        values: &[],
        summary: "rewrite the user service Cataly created from this version (update and rollback run it)",
    },
    Spec {
        path: &["setup"],
        args: &[],
        flags: &["--json", "--yes", "--profile"],
        values: &[
            "--owner",
            "--guild",
            "--wait",
            "--lead-model",
            "--lead-name",
            "--lead-persona",
            "--lead-cwd",
            "--approvals",
            "--backup",
            "--backup-repo",
            "--service",
            "--expect",
            "--omp",
            "--log-level",
            "--discord-token-file",
            "--telegram-token-file",
            "--telegram-owner",
            "--telegram-group",
            "--telegram-topic",
            "--slack-token-file",
            "--slack-role",
            "--slack-owner",
            "--fallback-on",
            "--fallback-chain",
        ],
        summary: "the whole setup in one run: asks for the Discord bot token, then fills in defaults \
                  (owner, #cataly and #cataly-ops, lead model, remote approvals, bot avatar and banner, \
                  home backup, health and pressure jobs, user service), shows a short summary and asks \
                  once; again later it changes only what a flag names. --yes answers in scripts; \
                  --owner <id|app>, --guild <id>, --lead-model <provider/id>, --approvals/--backup/--service \
                  on|off, --backup-repo owner/name, --profile re-applies the bot's avatar and banner",
    },
    Spec {
        path: &["health"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "check the hub, OMP, jobs and files; exit 1 while a warning is not ignored",
    },
    Spec {
        path: &["limits"],
        args: &[],
        flags: &["--json", "--refresh"],
        values: &[],
        summary: "show account usage limits from OMP (cached; --refresh reads now)",
    },
    Spec {
        path: &["quota"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "show the quota gate",
    },
    Spec {
        path: &["quota", "lift"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "lift the quota gate until the windows that closed it reset",
    },
    Spec {
        path: &["pr", "follow"],
        args: &["pr"],
        flags: &["--json"],
        values: &["--job"],
        summary: "follow a pull request (owner/repo#N or its URL)",
    },
    Spec {
        path: &["pr", "unfollow"],
        args: &["pr"],
        flags: &["--json"],
        values: &["--job"],
        summary: "stop following a pull request",
    },
    Spec {
        path: &["pr", "list"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "list the pull requests followed",
    },
    Spec {
        path: &["lead", "start"],
        args: &[],
        flags: &["--json", "--fresh"],
        values: &[],
        summary: "start the lead (resumes its last session; --fresh starts a new one)",
    },
    Spec {
        path: &["lead", "stop"],
        args: &[],
        flags: &["--json", "--force"],
        values: &[],
        summary: "stop the lead (--force interrupts a running turn first)",
    },
    Spec {
        path: &["lead", "status"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "show the lead session and its inbox",
    },
    Spec {
        path: &["lead", "send"],
        args: &["text"],
        flags: &["--json", "--quiet"],
        values: &["--request-id"],
        summary: "give the lead a message; exit 5 when it is in doubt (never send it again)",
    },
    Spec {
        path: &["lead", "inbox"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "list the lead's waiting, sent and in-doubt messages and notes for the next wake",
    },
    Spec {
        path: &["lead", "confirm"],
        args: &["index"],
        flags: &["--json"],
        values: &[],
        summary: "an in-doubt message arrived: record it as delivered",
    },
    Spec {
        path: &["lead", "release"],
        args: &["index"],
        flags: &["--json"],
        values: &[],
        summary: "an in-doubt message did not arrive: deliver it again",
    },
    Spec {
        path: &["lead", "interrupt"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "interrupt the lead's running turn",
    },
    Spec {
        path: &["lead", "model"],
        args: &["model"],
        flags: &["--json"],
        values: &[],
        summary: "change the idle lead's model (provider/id) with readback",
    },
    Spec {
        path: &["lead", "accept-model"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "accept the model OMP reports after a model mismatch hold",
    },
    Spec {
        path: &["lead", "answer"],
        args: &["dialog", "answer"],
        flags: &["--json"],
        values: &[],
        summary: "answer a lead dialog with JSON such as '{\"value\":\"Deny\"}'",
    },
    Spec {
        path: &["lead", "events"],
        args: &[],
        flags: &["--json"],
        values: &["--after"],
        summary: "show the lead session's recent events after a sequence number",
    },
    Spec {
        path: &["discord", "status"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "show Discord intake: connection, catch-up, queue, held rooms and owed replies",
    },
    Spec {
        path: &["discord", "release"],
        args: &["room"],
        flags: &["--json"],
        values: &[],
        summary: "release a held room; its in-doubt message counts as handled and is not sent again",
    },
    Spec {
        path: &["discord", "reset"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "forget Discord intake state (needed after changing the bot or the owner)",
    },
    Spec {
        path: &["telegram", "status"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "show Telegram intake: polling, queue, held rooms, owed replies and receive lag",
    },
    Spec {
        path: &["telegram", "release"],
        args: &["room"],
        flags: &["--json"],
        values: &[],
        summary: "release a held Telegram room; its in-doubt message counts as handled",
    },
    Spec {
        path: &["telegram", "reset"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "forget Telegram intake state (needed after changing the bot or the owner)",
    },
    Spec {
        path: &["slack", "status"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "show Slack intake: socket, catch-up, queue, held rooms, remembered threads",
    },
    Spec {
        path: &["slack", "release"],
        args: &["room"],
        flags: &["--json"],
        values: &[],
        summary: "release a held Slack room; its in-doubt message counts as handled",
    },
    Spec {
        path: &["slack", "reset"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "forget Slack intake state (needed after changing the account or the owner)",
    },
    Spec {
        path: &["slack", "upload"],
        args: &["workspace/channel", "file"],
        flags: &["--json"],
        values: &["--thread"],
        summary: "upload a file into a Slack conversation, named <workspace>/<conversation> (optionally a thread)",
    },
    Spec {
        path: &["voice", "status"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "show voice: running or off and why, hold, today's usage and waiting replies",
    },
    Spec {
        path: &["voice", "restart"],
        args: &[],
        flags: &["--json"],
        values: &[],
        summary: "lift a voice hold and start voice again",
    },
    Spec {
        path: &["voice", "reply"],
        args: &["request", "reply"],
        flags: &["--json"],
        values: &["--subject"],
        summary: "queue the lead's reply to a voice request; it is read aloud at the next pause",
    },
];

/// A parsed command line.
#[derive(Debug)]
pub(crate) struct Parsed {
    pub(crate) spec: &'static Spec,
    pub(crate) args: Vec<String>,
    flags: Vec<&'static str>,
    values: Vec<(&'static str, String)>,
}

impl Parsed {
    pub(crate) fn flag(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }

    pub(crate) fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.as_str())
    }

    pub(crate) fn is(&self, path: &[&str]) -> bool {
        self.spec.path == path
    }
}

/// What the command line asks for.
#[derive(Debug)]
pub(crate) enum Invocation {
    Run(Parsed),
    /// Usage text to print; nothing runs.
    Help(String),
}

/// Parses the words after the program name; the error is the one-line refusal.
pub(crate) fn parse(words: &[String]) -> Result<Invocation, String> {
    match words.first().map(String::as_str) {
        None | Some("help" | "--help" | "-h") => return Ok(Invocation::Help(usage(None))),
        _ => {}
    }
    let spec = COMMANDS
        .iter()
        .filter(|c| c.path.len() <= words.len() && c.path.iter().zip(words).all(|(p, w)| p == w))
        .max_by_key(|c| c.path.len())
        .ok_or_else(|| {
            let typed: Vec<&str> = words.iter().take(2).map(String::as_str).collect();
            format!("unknown command '{}'; see cataly --help", typed.join(" "))
        })?;
    let mut parsed = Parsed {
        spec,
        args: Vec::new(),
        flags: Vec::new(),
        values: Vec::new(),
    };
    let mut rest = words.iter().skip(spec.path.len());
    while let Some(word) = rest.next() {
        let word = word.as_str();
        if word == "--help" || word == "-h" {
            return Ok(Invocation::Help(usage(Some(spec))));
        }
        if let Some(name) = spec.values.iter().find(|v| **v == word) {
            let value = rest.next().ok_or_else(|| format!("{word} needs a value"))?;
            if value.trim().is_empty() {
                return Err(format!("{word} needs a non-empty value"));
            }
            if parsed.value(name).is_some() {
                return Err(format!("{word} given twice"));
            }
            parsed.values.push((name, value.clone()));
        } else if let Some(name) = spec.flags.iter().find(|f| **f == word) {
            parsed.flags.push(name);
        } else if word.starts_with('-') && word.len() > 1 {
            return Err(format!("unknown flag {word} for '{}'", spec.path.join(" ")));
        } else if parsed.args.len() < spec.args.len() {
            if word.trim().is_empty() {
                return Err(format!(
                    "empty {} refused",
                    spec.args.get(parsed.args.len()).unwrap_or(&"argument")
                ));
            }
            parsed.args.push(word.to_string());
        } else {
            return Err(format!(
                "unexpected argument '{word}' for '{}'",
                spec.path.join(" ")
            ));
        }
    }
    if let Some(missing) = spec.args.get(parsed.args.len()) {
        return Err(format!("'{}' needs <{missing}>", spec.path.join(" ")));
    }
    Ok(Invocation::Run(parsed))
}

fn synopsis(spec: &Spec) -> String {
    let mut s = format!("cataly {}", spec.path.join(" "));
    for a in spec.args {
        let _ = write!(s, " <{a}>");
    }
    for v in spec.values {
        let _ = write!(s, " [{v} <value>]");
    }
    for f in spec.flags {
        let _ = write!(s, " [{f}]");
    }
    s
}

/// Usage for one command, or for all.
pub(crate) fn usage(spec: Option<&Spec>) -> String {
    if let Some(spec) = spec {
        return format!("{}\n  {}\n", synopsis(spec), spec.summary);
    }
    let mut text = String::from("usage: cataly <command> [flags]\n\ncommands:\n");
    for c in &COMMANDS {
        let _ = writeln!(text, "  {:<16} {}", c.path.join(" "), c.summary);
    }
    text.push_str(
        "\nflags that take a value use the next word as it is, even when it starts with '-'.\n",
    );
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &[&str]) -> Vec<String> {
        s.iter().map(|w| (*w).to_string()).collect()
    }

    fn run(s: &[&str]) -> Parsed {
        match parse(&words(s)).unwrap() {
            Invocation::Run(p) => p,
            Invocation::Help(h) => panic!("unexpected help: {h}"),
        }
    }

    #[test]
    fn verbs_flags_and_values() {
        let p = run(&["events", "--since", "10m", "--follow", "--json"]);
        assert!(p.is(&["events"]) && p.flag("--follow") && p.flag("--json"));
        assert_eq!(p.value("--since"), Some("10m"));
        let p = run(&["job", "enable", "nightly", "--ack"]);
        assert!(p.is(&["job", "enable"]) && p.flag("--ack"));
        assert_eq!(p.args, ["nightly"]);
    }

    #[test]
    fn value_flags_take_the_next_word_verbatim() {
        let p = run(&["config", "check", "--file", "--help"]);
        assert_eq!(p.value("--file"), Some("--help"));
        let p = run(&["events", "--after", "-5"]);
        assert_eq!(p.value("--after"), Some("-5"));
    }

    #[test]
    fn refusals_are_single_lines() {
        for (input, needle) in [
            (&["events", "--since"][..], "--since needs a value"),
            (&["job", "run"][..], "needs <name>"),
            (&["job", "run", ""][..], "empty name refused"),
            (&["job", "run", "a", "b"][..], "unexpected argument 'b'"),
            (&["status", "--verbose"][..], "unknown flag --verbose"),
            (&["launch"][..], "unknown command 'launch'"),
            (&["events", "--limit", " "][..], "non-empty value"),
            (
                &["events", "--limit", "1", "--limit", "2"][..],
                "given twice",
            ),
        ] {
            let err = parse(&words(input)).unwrap_err();
            assert!(err.contains(needle), "{input:?}: {err}");
            assert!(!err.contains('\n'));
        }
    }

    #[test]
    fn help_runs_nothing() {
        assert!(matches!(parse(&[]).unwrap(), Invocation::Help(_)));
        assert!(matches!(
            parse(&words(&["--help"])).unwrap(),
            Invocation::Help(_)
        ));
        match parse(&words(&["job", "run", "--help"])).unwrap() {
            Invocation::Help(h) => assert!(h.starts_with("cataly job run <name>")),
            Invocation::Run(_) => panic!("help expected"),
        }
        assert!(usage(None).contains("config check"));
    }
}

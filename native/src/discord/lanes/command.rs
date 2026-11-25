//! `wakeCommand` (`discord-lane-wake-command.ts`) and the subset of `headlessArgv` its output can reach.

use std::path::Path;

use crate::util::has_control;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct WakeCommand {
    /// The interactive OMP launch argv, ending in `--cataly-role lane`.
    pub(super) launch: Vec<String>,
    /// The argv prefix for `omp session lease`.
    pub(super) lease: Vec<String>,
}

fn basename(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or(path)
}

/// `OMP_EXECUTABLE`: `(?:^|/)omp$|@oh-my-pi/pi-coding-agent/dist/cli\.js$`.
fn omp_executable(word: &str) -> bool {
    word == "omp"
        || word.ends_with("/omp")
        || word.ends_with("@oh-my-pi/pi-coding-agent/dist/cli.js")
}

/// `sourceOmpArgv`: the pinned source launcher's exact argv prefix.
fn source_omp(argv: &[String]) -> bool {
    let word = |at: usize| argv.get(at).map_or("", String::as_str);
    if !(word(0) == "bun" || word(0).ends_with("/bun")) || word(1) != "--preload" {
        return false;
    }
    let Some(root) = word(2).strip_suffix("scripts/omp.ts") else {
        return false;
    };
    // `^(.+\/packages\/coding-agent\/)scripts\/omp\.ts$`: greedy `.+` before the fixed suffix.
    if !root.ends_with("/packages/coding-agent/") || root.len() <= "/packages/coding-agent/".len() {
        return false;
    }
    let timing = word(3) == "--preload";
    if timing && word(4) != format!("{root}scripts/../../utils/src/module-timer.ts") {
        return false;
    }
    let entry = word(if timing { 5 } else { 3 });
    entry == format!("{root}src/cli.ts") || entry == format!("{root}scripts/../src/cli.ts")
}

/// `\{\w+\}` anywhere in `value`.
fn has_placeholder(value: &str) -> bool {
    value.match_indices('{').any(|(at, _)| {
        let rest = &value[at + 1..];
        let word = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        word > 0 && rest[word..].starts_with('}')
    })
}

/// `wakeCommand(template)`: only known OMP launchers and interactive options; `None` holds the wake.
pub(super) fn wake_command(template: &[String]) -> Option<WakeCommand> {
    if template.last().map(String::as_str) != Some("{prompt}")
        || template.iter().any(|arg| has_control(arg))
    {
        return None;
    }
    let executable = template.first().map_or("", String::as_str);
    let bin = basename(executable);
    let script_at = if bin == "bun" && template.get(1).map(String::as_str) == Some("run") {
        2
    } else {
        1
    };
    let word = |at: usize| template.get(at).map_or("", String::as_str);
    let end = if omp_executable(executable) {
        1
    } else if bin == "omp-cataly" && word(1) == "omp" {
        2
    } else if source_omp(template) {
        if word(3) == "--preload" { 6 } else { 4 }
    } else if (bin == "bun" || bin == "node") && omp_executable(word(script_at)) {
        script_at + 1
    } else {
        0
    };
    if end == 0 || end >= template.len() || executable.starts_with('-') || executable.contains('=')
    {
        return None;
    }
    let mut launch = template[..end].to_vec();
    let mut lease = launch.clone();
    let last = template.len() - 1;
    let mut at = end;
    while at < last {
        let arg = &template[at];
        if arg == "--no-extensions" {
            launch.push(arg.clone());
            at += 1;
            continue;
        }
        // `^(--[\w-]+)=(.*)$`
        let inline = arg.strip_prefix("--").and_then(|rest| {
            let (name, value) = rest.split_once('=')?;
            (!name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .then_some((&arg[..name.len() + 2], value))
        });
        let flag = inline.map_or(arg.as_str(), |(flag, _)| flag);
        let value = match inline {
            Some((_, value)) => Some(value),
            None if at + 1 < last => {
                at += 1;
                Some(template[at].as_str())
            }
            None => None,
        };
        at += 1;
        if flag == "--model" && value == Some("{model}") {
            continue;
        }
        if flag == "--cataly-role" && value == Some("lane") {
            continue;
        }
        let value =
            value.filter(|v| !v.is_empty() && !v.starts_with('-') && !has_placeholder(v))?;
        if !matches!(flag, "--profile" | "--config" | "--extension" | "-e") {
            return None;
        }
        launch.push(flag.to_owned());
        launch.push(value.to_owned());
        if flag == "--profile" {
            lease.push(flag.to_owned());
            lease.push(value.to_owned());
        }
    }
    launch.push("--cataly-role".to_owned());
    launch.push("lane".to_owned());
    Some(WakeCommand { launch, lease })
}

/// Whether `headlessArgv([...launch, "{prompt}"], model)` accepts a `wakeCommand` launch, and its result.
///
/// Every option `wakeCommand` keeps is a headless-allowed native option and its role is already last, so the
/// headless argv equals `launch`. Only the side wrapper (`omp-cataly omp`), whose executable is not OMP's own,
/// fails the headless direct-launcher rule.
pub(super) fn headless_argv(command: &WakeCommand) -> Option<Vec<String>> {
    let bin = basename(command.launch.first()?);
    (bin != "omp-cataly").then_some(command.launch.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn default_template_becomes_a_lane_launch() {
        let command = wake_command(&argv(&[
            "omp",
            "--cataly-role",
            "lane",
            "--model",
            "{model}",
            "{prompt}",
        ]))
        .unwrap();
        assert_eq!(command.launch, argv(&["omp", "--cataly-role", "lane"]));
        assert_eq!(command.lease, argv(&["omp"]));
        assert_eq!(headless_argv(&command), Some(command.launch.clone()));
    }

    #[test]
    fn managed_launcher_options_are_kept() {
        let command = wake_command(&argv(&[
            "/r/scripts/consumer/omp",
            "--no-extensions",
            "-e",
            "/r/extension",
            "--profile=work",
            "--config",
            "/c/omp.yml",
            "{prompt}",
        ]))
        .unwrap();
        assert_eq!(
            command.launch,
            argv(&[
                "/r/scripts/consumer/omp",
                "--no-extensions",
                "-e",
                "/r/extension",
                "--profile",
                "work",
                "--config",
                "/c/omp.yml",
                "--cataly-role",
                "lane"
            ])
        );
        assert_eq!(
            command.lease,
            argv(&["/r/scripts/consumer/omp", "--profile", "work"])
        );
    }

    #[test]
    fn unknown_or_unsafe_templates_hold() {
        assert!(wake_command(&argv(&["omp", "--yolo", "x", "{prompt}"])).is_none());
        assert!(wake_command(&argv(&["omp", "--config", "{x}", "{prompt}"])).is_none());
        assert!(wake_command(&argv(&["claude", "{prompt}"])).is_none());
        assert!(wake_command(&argv(&["omp"])).is_none());
        assert!(wake_command(&argv(&["omp", "--config", "a\u{7}", "{prompt}"])).is_none());
        let side = wake_command(&argv(&["omp-cataly", "omp", "{prompt}"])).unwrap();
        assert_eq!(side.lease, argv(&["omp-cataly", "omp"]));
        assert_eq!(headless_argv(&side), None);
    }

    #[test]
    fn source_and_bun_launchers() {
        let root = "/s/packages/coding-agent/";
        let source = [
            "bun".to_owned(),
            "--preload".to_owned(),
            format!("{root}scripts/omp.ts"),
            format!("{root}src/cli.ts"),
            "{prompt}".to_owned(),
        ];
        assert_eq!(wake_command(&source).unwrap().launch.len(), 6);
        let run = wake_command(&argv(&["bun", "run", "/x/omp", "{prompt}"])).unwrap();
        assert_eq!(run.lease, argv(&["bun", "run", "/x/omp"]));
        assert!(has_placeholder("a{b_1}c") && !has_placeholder("{}") && !has_placeholder("{a"));
    }
}

//! `cataly setup` end to end against the fake Discord, a fake `gh`, a fake OMP and a fake service
//! manager, in a temporary home with `umask 0002`: the first run at a terminal (token typed hidden,
//! the Message Content intent switched on, the invite awaited, channels created, avatar and banner
//! set, config written, home backup and service set up), a second run that changes nothing, a
//! hand-set avatar that is kept until `--profile`, the scripted `--yes` path, and the stops that
//! need the owner.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use support::discord::{APP_OWNER, FakeDiscord, GUILD};
use support::{Step, TestHub};

const TOKEN: &str = "setup-token-not-real";
const LEAD: &str = "500000000000000010";
const OPS: &str = "500000000000000011";
const MODEL: &str = "anthropic/claude-opus-5-5";
const RUN: Duration = Duration::from_secs(60);

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// A home where an earlier run under `umask 0002` left the config folder open to the group, the
/// config points at the fake Discord, and fake `omp`, `gh`, `systemctl` and `launchctl` come first
/// on PATH. With `installed`, Cataly looks installed from a release (the service needs that).
fn sandbox(installed: bool) -> (TestHub, FakeDiscord) {
    let fake = FakeDiscord::start();
    fake.set_token(TOKEN);
    let mut hub = TestHub::new("");
    let config_dir = hub.root.join("config/cataly");
    std::fs::remove_dir_all(&config_dir).unwrap();
    std::fs::create_dir(&config_dir).unwrap();
    std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o775)).unwrap();
    hub.write_config(&format!(
        "# mine\n[discord]\napi_base = \"{}\"\n",
        fake.base()
    ));
    hub.install_fake("omp");
    hub.install_fake("gh");
    hub.fixture(
        "omp",
        "model-roles.json",
        Some(
            &json!({ "key": "modelRoles", "value": { "default": format!("{MODEL}:high") } })
                .to_string(),
        ),
    );
    hub.fixture(
        "gh",
        "user.json",
        Some(&json!({ "login": "owner", "name": "Owner", "id": 7 }).to_string()),
    );
    for manager in ["systemctl", "launchctl"] {
        let path = hub.root.join("bin").join(manager);
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/manager.log\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    if installed {
        let root = hub.root.join("home/.local/share/cataly");
        std::fs::create_dir_all(root.join("versions/0.1.0")).unwrap();
        std::os::unix::fs::symlink("versions/0.1.0", root.join("current")).unwrap();
    }
    let mut path = std::ffi::OsString::from(hub.root.join("bin"));
    path.push(":");
    path.push(support::path_without_omp());
    hub.env.push(("PATH".into(), path.into()));
    (hub, fake)
}

fn config_dir(hub: &TestHub) -> PathBuf {
    hub.root.join("config/cataly")
}

/// The names of the text channels created; the category is counted by `categories`.
fn creates(fake: &FakeDiscord) -> Vec<String> {
    fake.calls("POST", "/guilds/")
        .into_iter()
        .filter(|s| s.body["type"] == 0)
        .map(|s| s.body["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// The service definition and the manager's log.
fn service(hub: &TestHub) -> (String, String) {
    let unit = if cfg!(target_os = "macos") {
        hub.root
            .join("home/Library/LaunchAgents/dev.cataly.hub.plist")
    } else {
        hub.root.join("config/systemd/user/cataly.service")
    };
    (read(&unit), read(&hub.root.join("bin/manager.log")))
}

/// Runs `cataly setup` with `args` and `--json`: success, the report, stderr.
fn json_run(hub: &TestHub, args: &[&str]) -> (bool, Value, String) {
    let mut all = vec!["setup", "--json"];
    all.extend_from_slice(args);
    let out = hub.umask_command("0002", &all).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(
        !stdout.contains(TOKEN) && !stderr.contains(TOKEN),
        "token leaked"
    );
    let report = serde_json::from_str(&stdout).unwrap_or(Value::Null);
    (out.status.success(), report, stderr)
}

fn item<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["summary"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["item"] == name)
        .unwrap()
}

#[test]
fn first_run_at_a_terminal_then_a_second_run_changes_nothing() {
    let (hub, fake) = sandbox(true);
    fake.set_app_flags(1 << 23);
    let steps: Vec<Step<'_>> = vec![
        (
            "Bot token (not shown):",
            Box::new(|| Some(format!("{TOKEN}\n"))),
        ),
        (
            "Add the bot to your server",
            Box::new(|| {
                fake.join(GUILD, "home");
                None
            }),
        ),
        (
            "Apply these changes? [Y/n]",
            Box::new(|| Some("y\n".into())),
        ),
    ];
    let (code, shown) = hub.pty(&["setup"], steps, RUN);
    assert_eq!(code, Some(0), "{shown}");
    assert!(!shown.contains(TOKEN), "the token is never shown:\n{shown}");
    assert!(
        shown.contains("Message Content intent: switched on"),
        "{shown}"
    );
    assert_eq!(fake.app_flags(), (1 << 23) | (1 << 19));
    assert!(
        shown.contains("permissions=2252126231268432"),
        "the invite link:\n{shown}"
    );
    assert_eq!(creates(&fake), ["cataly", "cataly-ops"]);

    // Owner-only folders and files whatever the umask; the loose config folder was tightened.
    let dir = config_dir(&hub);
    for d in [dir.clone(), dir.join("secrets"), hub.state()] {
        assert_eq!(mode(&d), 0o700, "{d:?}");
    }
    for f in [
        hub.config_path(),
        dir.join("secrets/discord-token"),
        dir.join("secrets/service.env"),
    ] {
        assert_eq!(mode(&f), 0o600, "{f:?}");
    }
    assert_eq!(read(&dir.join("secrets/discord-token")).trim(), TOKEN);

    let text = read(&hub.config_path());
    assert!(text.starts_with("# mine\n"), "{text}");
    let lead = fake.calls("POST", "/guilds/")[0].path.clone();
    assert!(lead.contains(GUILD), "{lead}");
    for line in [
        format!("guild = \"{GUILD}\""),
        format!("owner = \"{APP_OWNER}\""),
        "remote_approvals = true".to_string(),
        "[destinations.cataly-ops]\nkind = \"discord\"".to_string(),
        format!("[lead]\nmodel = \"{MODEL}\""),
        "[jobs.health]\nkind = \"health\"\ndestinations = [\"cataly-ops\"]".to_string(),
        "[jobs.home]\nkind = \"backup\"".to_string(),
        format!("path = \"{}\"", hub.root.join("bin/omp").display()),
    ] {
        assert!(text.contains(&line), "{line} missing:\n{text}");
    }
    let check = hub.cli(&["config", "check"]);
    assert!(check.status.success(), "{check:?}");

    // The bot's avatar and banner are Cataly's, and so is the application's icon (the avatar).
    for field in ["avatar", "banner", "icon"] {
        let (_, data) = fake.image(field).unwrap();
        assert!(data.starts_with("data:image/jpeg;base64,/9j/"), "{field}");
    }
    assert_eq!(
        fake.image("icon").unwrap().1,
        fake.image("avatar").unwrap().1
    );
    // The home backup's private repository and the service.
    let gh = read(&hub.root.join("bin/gh-data/calls.log"));
    assert!(
        gh.contains("repo create owner/cataly-home --private"),
        "{gh}"
    );
    assert!(hub.state().join(".git").exists());
    let (unit, log) = service(&hub);
    assert!(unit.contains("cataly"), "{unit}");
    if cfg!(target_os = "macos") {
        assert!(log.contains("bootstrap"), "{log}");
    } else {
        assert!(log.contains("--user enable --now cataly.service"), "{log}");
    }

    // A second run shows what is set and changes nothing: no question, no request that writes.
    let patches = fake.calls("PATCH", "/users/@me").len();
    let app_patches = fake.calls("PATCH", "/applications/@me").len();
    let (code, shown) = hub.pty(&["setup"], Vec::new(), RUN);
    assert_eq!(code, Some(0), "{shown}");
    assert!(shown.contains("nothing to change"), "{shown}");
    assert!(!shown.contains("Apply these changes"), "{shown}");
    assert_eq!(read(&hub.config_path()), text);
    assert_eq!(creates(&fake).len(), 2);
    assert_eq!(fake.calls("PATCH", "/users/@me").len(), patches);
    assert_eq!(fake.calls("PATCH", "/applications/@me").len(), app_patches);
    assert_eq!(service(&hub).1, log);
}

#[test]
fn a_hand_set_avatar_is_kept_until_profile_is_asked() {
    let (hub, fake) = sandbox(false);
    let secrets = config_dir(&hub).join("secrets");
    std::fs::create_dir(&secrets).unwrap();
    std::fs::set_permissions(&secrets, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(secrets.join("discord-token"), TOKEN).unwrap();
    std::fs::set_permissions(
        secrets.join("discord-token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fake.join(GUILD, "home");
    fake.named(LEAD, "cataly", 0, GUILD);
    fake.named(OPS, "cataly-ops", 0, GUILD);
    let (ok, done, stderr) = json_run(&hub, &["--yes", "--backup", "off"]);
    assert!(ok, "{stderr}");
    assert_eq!(done["applied"], true);
    let first = fake.image("avatar").unwrap();

    assert!(
        read(&hub.config_path()).contains("[setup]\nbackup = false\n"),
        "the turned-off backup is remembered"
    );

    // The owner sets his own avatar and application icon: a plain run keeps them and Cataly's
    // banner, and does not offer the backup he turned off.
    fake.set_image("avatar", "mine");
    fake.set_image("icon", "my-icon");
    let (ok, again, stderr) = json_run(&hub, &["--yes"]);
    assert!(ok, "{stderr}");
    assert_eq!(again["action"], "keep", "{again}");
    let backup = item(&again, "backup");
    assert_eq!(backup["change"], false);
    assert!(
        backup["value"]
            .as_str()
            .unwrap()
            .contains("you turned it off"),
        "{backup}"
    );
    let profile = item(&again, "profile");
    assert_eq!(profile["change"], false);
    assert!(
        profile["value"]
            .as_str()
            .unwrap()
            .contains("avatar and icon: yours, kept"),
        "{profile}"
    );
    assert_eq!(fake.image("avatar").unwrap().0, "mine");
    assert_eq!(fake.image("icon").unwrap().0, "my-icon");
    assert_eq!(fake.calls("PATCH", "/users/@me").len(), 1);

    // `--profile` applies Cataly's images again, after the same one confirmation.
    let (ok, _, stderr) = json_run(&hub, &["--profile", "--yes", "--backup", "off"]);
    assert!(ok, "{stderr}");
    let (hash, data) = fake.image("avatar").unwrap();
    assert_ne!(hash, "mine");
    assert_eq!(data, first.1);
    let (icon, icon_data) = fake.image("icon").unwrap();
    assert_ne!(icon, "my-icon");
    assert_eq!(icon_data, first.1, "the icon is the avatar image");
}

#[test]
fn a_script_sets_up_with_yes_and_flags() {
    let (hub, fake) = sandbox(false);
    let token = hub.private_file("discord-token", TOKEN);
    fake.join(GUILD, "home");
    fake.named(LEAD, "cataly", 0, GUILD);
    let owner = "100000000000000001";
    let flags = [
        "--discord-token-file",
        token.to_str().unwrap(),
        "--owner",
        owner,
        "--lead-model",
        "openai-codex/gpt-5",
        "--approvals",
        "off",
        "--backup",
        "off",
        "--service",
        "off",
    ];
    // Without --yes a script gets the report and nothing changes.
    let before = read(&hub.config_path());
    let (ok, preview, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(preview["applied"], false);
    assert_eq!(preview["action"], "update");
    assert_eq!(item(&preview, "channels")["change"], true);
    assert_eq!(read(&hub.config_path()), before);
    assert_eq!(creates(&fake), Vec::<String>::new());

    // --expect guards a scripted edit of the file the preview saw.
    let mut apply = flags.to_vec();
    apply.extend(["--yes", "--expect", "0000"]);
    let (ok, _, stderr) = json_run(&hub, &apply);
    assert!(
        !ok && stderr.contains("changed since its preview"),
        "{stderr}"
    );
    let digest = preview["before"].as_str().unwrap().to_string();
    let mut apply = flags.to_vec();
    apply.extend(["--yes", "--expect", &digest]);
    let (ok, done, stderr) = json_run(&hub, &apply);
    assert!(ok, "{stderr}");
    assert_eq!(done["applied"], true);
    assert_eq!(creates(&fake), ["cataly-ops"], "only the missing channel");
    let text = read(&hub.config_path());
    for line in [
        format!("owner = \"{owner}\""),
        format!("channels = [\"{LEAD}\"]"),
        "remote_approvals = false".to_string(),
        "model = \"openai-codex/gpt-5\"".to_string(),
    ] {
        assert!(text.contains(&line), "{line} missing:\n{text}");
    }
    assert!(!text.contains("[jobs.home]"), "{text}");
    assert_eq!(service(&hub).0, "");
    let check = hub.cli(&["config", "check"]);
    assert!(check.status.success(), "{check:?}");

    // Run again with the same flags: nothing changes.
    let (ok, again, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(again["action"], "keep", "{again}");
    assert!(
        again["summary"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["change"] == false),
        "{again}"
    );
}

#[test]
fn steps_that_need_the_owner_stop_a_script() {
    let (hub, fake) = sandbox(false);
    let (ok, report, stderr) = json_run(&hub, &["--yes"]);
    assert!(!ok);
    assert_eq!(report["discord"]["stage"], "token");
    assert!(stderr.contains("Developer Portal"), "{stderr}");
    assert!(fake.seen().is_empty(), "no token, no request");

    let token = hub.private_file("discord-token", TOKEN);
    let file = ["--discord-token-file", token.to_str().unwrap(), "--yes"];
    let (ok, report, stderr) = json_run(&hub, &file);
    assert!(!ok);
    assert_eq!(report["discord"]["stage"], "guild");
    assert!(stderr.contains("no server yet"), "{stderr}");

    fake.join(GUILD, "home");
    fake.join("500000000000000099", "work");
    let (ok, report, stderr) = json_run(&hub, &file);
    assert!(!ok);
    assert_eq!(report["discord"]["stage"], "guild");
    assert!(stderr.contains("--guild"), "{stderr}");
    assert_eq!(creates(&fake), Vec::<String>::new());
}

/// The names of the categories (channel type 4) created.
fn categories(fake: &FakeDiscord) -> Vec<String> {
    fake.calls("POST", "/guilds/")
        .into_iter()
        .filter(|s| s.body["type"] == 4)
        .map(|s| s.body["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

/// A home with the fake joined to the guild, and the flags of a scripted run that applies.
fn scripted_sandbox() -> (TestHub, FakeDiscord, Vec<String>) {
    let (hub, fake) = sandbox(false);
    let token = hub.private_file("discord-token", TOKEN);
    fake.join(GUILD, "home");
    let flags = [
        "--discord-token-file",
        token.to_str().unwrap(),
        "--owner",
        "100000000000000001",
        "--lead-model",
        "openai-codex/gpt-5",
        "--backup",
        "off",
        "--service",
        "off",
        "--yes",
    ]
    .map(String::from)
    .to_vec();
    (hub, fake, flags)
}

#[test]
fn a_fresh_server_gets_one_category_holding_both_channels() {
    let (hub, fake, flags) = scripted_sandbox();
    let flags: Vec<&str> = flags.iter().map(String::as_str).collect();
    let (ok, done, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(done["applied"], true);
    assert_eq!(categories(&fake), ["Cataly"]);
    assert_eq!(creates(&fake), ["cataly", "cataly-ops"]);
    let category = done["discord"]["category"]["id"].as_str().unwrap();
    assert_eq!(done["discord"]["category"]["state"], "created");
    let posts = fake.calls("POST", "/guilds/");
    assert_eq!(posts[0].body["type"], 4, "the category comes first");
    for post in &posts[1..] {
        assert_eq!(post.body["parent_id"], category, "{:?}", post.body);
    }
    assert!(fake.calls("PATCH", "/channels/").is_empty());
}

#[test]
fn a_second_run_makes_no_second_category_and_no_second_channel() {
    let (hub, fake, flags) = scripted_sandbox();
    let flags: Vec<&str> = flags.iter().map(String::as_str).collect();
    let (ok, _, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    let posts = fake.calls("POST", "/guilds/").len();
    assert_eq!(posts, 3);
    let (ok, done, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(fake.calls("POST", "/guilds/").len(), posts);
    assert!(fake.calls("PATCH", "/channels/").is_empty());
    assert_eq!(done["discord"]["category"]["state"], "existing");
    assert_eq!(categories(&fake), ["Cataly"]);
}

#[test]
fn channels_at_the_root_are_moved_into_the_category() {
    let (hub, fake, flags) = scripted_sandbox();
    let flags: Vec<&str> = flags.iter().map(String::as_str).collect();
    fake.named(LEAD, "cataly", 0, GUILD);
    fake.named(OPS, "cataly-ops", 0, GUILD);
    let (ok, done, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(done["applied"], true);
    assert_eq!(categories(&fake), ["Cataly"]);
    assert_eq!(creates(&fake), Vec::<String>::new());
    let category = done["discord"]["category"]["id"].as_str().unwrap();
    let patches = fake.calls("PATCH", "/channels/");
    let moved: Vec<&str> = patches
        .iter()
        .map(|m| m.path.trim_start_matches("/channels/"))
        .collect();
    assert_eq!(moved, [LEAD, OPS]);
    for m in &patches {
        assert_eq!(m.body["parent_id"], category, "{:?}", m.body);
    }

    // Now both sit in the category: a rerun moves nothing.
    let (ok, _, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(fake.calls("PATCH", "/channels/").len(), 2);
    assert_eq!(categories(&fake), ["Cataly"]);
}

/// An avatar the owner chose in chat (`onboarding.avatar` records it with `chosen`) is kept by a
/// plain run even though its image is not Cataly's default; without the mark the same record is
/// Cataly's stale default and is replaced.
#[test]
fn an_avatar_chosen_in_chat_is_kept_by_setup() {
    let (hub, fake, flags) = scripted_sandbox();
    let flags: Vec<&str> = flags.iter().map(String::as_str).collect();
    let (ok, _, stderr) = json_run(&hub, &flags);
    assert!(ok, "{stderr}");
    assert_eq!(fake.calls("PATCH", "/users/@me").len(), 1);
    let path = hub.state().join("discord-profile.json");
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for field in ["avatar", "icon"] {
        record[field]["image"] = json!("0".repeat(64));
    }
    std::fs::write(&path, record.to_string()).unwrap();

    // The image is not the default and nothing says the owner chose it: Cataly's own, stale.
    let (ok, again, stderr) = json_run(&hub, &["--yes"]);
    assert!(ok, "{stderr}");
    assert_eq!(fake.calls("PATCH", "/users/@me").len(), 2, "{again}");

    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for field in ["avatar", "icon"] {
        record[field]["image"] = json!("0".repeat(64));
        record[field]["chosen"] = json!(true);
    }
    std::fs::write(&path, record.to_string()).unwrap();
    let (ok, kept, stderr) = json_run(&hub, &["--yes"]);
    assert!(ok, "{stderr}");
    assert_eq!(fake.calls("PATCH", "/users/@me").len(), 2, "{kept}");
    let profile = item(&kept, "profile");
    assert!(
        profile["value"]
            .as_str()
            .unwrap()
            .contains("avatar and icon: yours, kept"),
        "{profile}"
    );
}

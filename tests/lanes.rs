//! Milestone 3a acceptance checks 1-10 through the real hub with the fake OMP (`tests/support/
//! fake-omp`, rpc-ui mode with turns and goals) and the fake Discord. A test speaks for a lane's
//! bridge over the hub socket with the launch token the fake OMP recorded.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::TestHub;
use support::discord::FakeDiscord;

const WAIT: Duration = Duration::from_secs(30);
const OWNER: &str = "400000000000000001";
const CH: &str = "600000000000000001";
const THREAD: &str = "600000000000000009";

/// Lane settings with short oversight timings; `extra` adds config lines.
fn lane_hub(extra: &str) -> (TestHub, PathBuf) {
    let hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    for f in ["rpc", "turns"] {
        hub.fixture("omp", f, Some(""));
    }
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lanes]\nmodel = \"fake/primary\"\ncwd = \"{}\"\nobjection = \"2s\"\n\
         [lanes.shell]\ndeny = [\"git push\", \"rm -rf\"]\n{extra}",
        omp.display(),
        work.display()
    ));
    (hub, work)
}

fn data(hub: &TestHub) -> PathBuf {
    hub.root.join("bin/omp-data")
}

/// Starts the hub and waits until the OMP probe finished (starts need it, DESIGN 3.4).
fn start(hub: &mut TestHub) {
    hub.start();
    hub.until(WAIT, || {
        hub.json(&["status", "--json"])["omp"]
            .is_object()
            .then_some(())
    });
}

/// One lane operation; `Err` is the CLI's refusal.
fn lane(hub: &TestHub, op: &str, params: &Value) -> Result<Value, String> {
    let text = params.to_string();
    let out = hub.cli(&["lane", op, "--json", "--params", &text]);
    if out.status.success() {
        Ok(serde_json::from_slice(&out.stdout).unwrap())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn open(hub: &TestHub, key: &str, extra: &Value) -> Value {
    let mut p = json!({
        "key": key,
        "title": format!("Work {key}"),
        "brief": "Do the work.",
        "checks": [{ "kind": "command", "argv": ["true"] }],
    });
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    lane(hub, "open", &p).unwrap()
}

fn record(hub: &TestHub, key: &str) -> Value {
    let all = lane(hub, "list", &json!({ "all": true })).unwrap();
    all.as_array()
        .unwrap()
        .iter()
        .find(|l| l["key"] == key)
        .cloned()
        .unwrap_or(Value::Null)
}

fn events_of(hub: &TestHub, kind: &str) -> Vec<Value> {
    hub.events()
        .into_iter()
        .filter(|e| e["kind"] == kind)
        .collect()
}

fn goal(hub: &TestHub, session: &Value) -> String {
    std::fs::read_to_string(data(hub).join(format!("goal-{}", session.as_str().unwrap())))
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// The launch token the fake OMP of this session recorded.
fn token(hub: &TestHub, session: &Value) -> String {
    let text = std::fs::read_to_string(data(hub).join("launch")).unwrap();
    text.lines()
        .rfind(|l| l.split(' ').nth(1) == session.as_str())
        .and_then(|l| l.split(' ').next())
        .unwrap()
        .to_string()
}

/// A test-side bridge connection.
struct Bridge {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next: u64,
}

impl Bridge {
    fn connect(hub: &TestHub, params: Value) -> (Self, Value) {
        let writer = UnixStream::connect(hub.socket()).unwrap();
        writer
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let reader = BufReader::new(writer.try_clone().unwrap());
        let mut b = Self {
            reader,
            writer,
            next: 1,
        };
        let answer = b.call("bridge.hello", params);
        (b, answer)
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let mut line = json!({ "v": 1, "id": id, "method": method });
        line["params"] = params;
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .unwrap();
        loop {
            let mut reply = String::new();
            self.reader.read_line(&mut reply).unwrap();
            let v: Value = serde_json::from_str(&reply).unwrap();
            if v["id"] == id {
                return v["ok"].clone();
            }
        }
    }

    fn lane_tool(&mut self, call: &str, session: &Value, input: Value) -> Value {
        let mut params = json!({ "call": call, "tool": "cataly_lane", "session": session });
        params["input"] = input;
        self.call("bridge.tool", params)
    }
}

fn hello(hub: &TestHub, rec: &Value) -> (Bridge, Value) {
    let tok = token(hub, &rec["session_id"]);
    Bridge::connect(
        hub,
        json!({ "ext": 1, "token": tok, "session": rec["session_id"], "agent": "main" }),
    )
}

/// Check 1: preview writes nothing; bad inputs are refused; request-ID dedupe.
#[test]
fn open_preview_refusals_and_dedupe() {
    let (mut hub, work) = lane_hub("");
    start(&mut hub);
    let pids = || std::fs::read_to_string(data(&hub).join("pids")).unwrap_or_default();
    let before = pids();
    let preview = open(&hub, "web-1", &json!({ "preview": true }));
    assert_eq!(preview["preview"], true);
    assert!(
        preview["brief"]
            .as_str()
            .unwrap()
            .contains("Lane instructions")
    );
    assert_eq!(
        lane(&hub, "list", &json!({ "all": true })).unwrap(),
        json!([])
    );
    assert_eq!(pids(), before, "preview started no process");
    assert!(
        !hub.state().join("sessions/lanes/web-1").exists(),
        "preview made no session directory"
    );
    let base =
        json!({ "title": "t", "brief": "b", "checks": [{ "kind": "command", "argv": ["true"] }] });
    let refused = |patch: Value| {
        let mut p = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            p[k] = v.clone();
        }
        lane(&hub, "open", &p).unwrap_err()
    };
    assert!(refused(json!({ "key": "Bad Key" })).contains("key"));
    assert!(refused(json!({ "key": "lead" })).contains("reserved"));
    assert!(
        refused(json!({ "key": "ok-1", "checks": [{ "kind": "pr_merged" }] })).contains("signal 1")
    );
    assert!(refused(json!({ "key": "ok-1", "checks": "merged" })).contains("list"));
    assert!(refused(json!({ "key": "ok-1", "model": "sonnet" })).contains("exact"));
    assert!(refused(json!({ "key": "ok-1", "model": "fake/*" })).contains("exact"));
    let first = open(
        &hub,
        "web-1",
        &json!({ "request_id": "req-1", "cwd": work }),
    );
    assert_eq!(first["outcome"], "started");
    let again = open(
        &hub,
        "web-1",
        &json!({ "request_id": "req-1", "cwd": work }),
    );
    assert_eq!(
        (again["outcome"].clone(), again["repeat"].clone()),
        (json!("started"), json!(true))
    );
    let other = lane(
        &hub,
        "open",
        &json!({ "key": "web-1", "title": "other", "brief": "b", "checks": base["checks"], "request_id": "req-1" }),
    );
    assert!(other.unwrap_err().contains("other inputs"));
    hub.stop();
}

/// Check 2: a model mismatch at start keeps the process, sends no brief, marks the start held and
/// tells the lead.
#[test]
fn model_mismatch_holds_the_start() {
    let (mut hub, _) = lane_hub("");
    hub.fixture("omp", "model", Some("fake/other"));
    start(&mut hub);
    let out = open(&hub, "m-1", &json!({}));
    assert_eq!(out["outcome"], "start held: model");
    let rec = record(&hub, "m-1");
    assert_eq!(rec["state"], "held");
    assert!(
        rec["status"]
            .as_str()
            .unwrap()
            .contains("start held: model"),
        "{rec}"
    );
    assert_eq!(rec["live"], true, "the process is kept for inspection");
    let file = std::fs::read_to_string(rec["session_file"].as_str().unwrap()).unwrap();
    assert!(!file.contains("Lane instructions"), "no brief was sent");
    assert!(goal(&hub, &rec["session_id"]).is_empty(), "no goal was set");
    let alerts = hub.until(WAIT, || {
        let a = events_of(&hub, "lane.alert");
        (!a.is_empty()).then_some(a)
    });
    assert!(
        alerts[0]["text"]
            .as_str()
            .unwrap()
            .contains("start held: model")
    );
    hub.stop();
}

/// Check 3: report authority and evidence novelty.
#[test]
fn reports_need_the_current_run_and_novelty_counts_only_new_evidence() {
    let (mut hub, work) = lane_hub("");
    start(&mut hub);
    open(&hub, "r-1", &json!({}));
    let rec = record(&hub, "r-1");
    std::fs::write(work.join("out.txt"), "result").unwrap();
    let (mut b, answer) = hello(&hub, &rec);
    assert_eq!(answer["role"], "lane", "{answer}");
    assert_eq!(answer["pin"], "fake/primary");
    let report = |b: &mut Bridge, call: &str, session: &Value| {
        b.lane_tool(
            call,
            session,
            json!({ "op": "report", "kind": "progress", "text": "built it", "files": ["out.txt"] }),
        )
    };
    let first = report(&mut b, "c1", &rec["session_id"]);
    assert!(
        first["text"]
            .as_str()
            .unwrap()
            .contains("1 of 1 attached items count as new"),
        "{first}"
    );
    let again = report(&mut b, "c2", &rec["session_id"]);
    assert!(
        again["text"].as_str().unwrap().contains("seen before"),
        "{again}"
    );
    // Another session's connection is refused: the hello named a session the lane does not own.
    open(&hub, "r-2", &json!({}));
    let other = record(&hub, "r-2");
    let (mut b2, _) = Bridge::connect(
        &hub,
        json!({ "ext": 1, "token": token(&hub, &other["session_id"]), "session": "not-this-one", "agent": "main" }),
    );
    let refused = report(&mut b2, "c3", &json!("not-this-one"));
    assert_eq!(refused["error"], true);
    assert!(
        refused["text"]
            .as_str()
            .unwrap()
            .contains("the lane moved on")
    );
    // An earlier run: park and reopen; the old connection's run is gone.
    lane(&hub, "park", &json!({ "key": "r-1", "reason": "later" })).unwrap();
    let closed = report(&mut b, "c4", &rec["session_id"]);
    assert!(
        closed["text"]
            .as_str()
            .unwrap()
            .contains("the lane moved on"),
        "a closed lane"
    );
    lane(&hub, "reopen", &json!({ "key": "r-1" })).unwrap();
    let earlier = report(&mut b, "c5", &rec["session_id"]);
    assert!(
        earlier["text"]
            .as_str()
            .unwrap()
            .contains("the lane moved on"),
        "an earlier run"
    );
    hub.stop();
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

/// The quiet claim notice never went out; it belonged to that run and ends with it, so a reopen
/// starts with an empty inbox apart from its own note.
fn reopen_leaves_the_claim_notice_behind(hub: &TestHub, closed: &Value) {
    assert!(
        closed["receipt"]
            .to_string()
            .contains("1 unsent note(s) retired"),
        "{closed}"
    );
    let note = json!({ "key": "c-ok", "note": "one more thing" });
    let reopened = lane(hub, "reopen", &note).unwrap();
    assert!(
        reopened
            .as_str()
            .unwrap()
            .starts_with("reopened on session"),
        "{reopened}"
    );
    let file = record(hub, "c-ok")["session_file"]
        .as_str()
        .unwrap()
        .to_string();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("one more thing"), "{text}");
    assert!(!text.contains("[claim recorded]"), "{text}");
    lane(hub, "close", &json!({ "key": "c-ok", "note": "done" })).unwrap();
}

/// Check 4: claim, objection window and automatic close; unsent work and a failing check object;
/// a crash after the close intent resumes the close from its step.
#[test]
fn claims_object_on_unsent_work_and_failing_checks_and_close_survives_a_crash() {
    let (mut hub, work) = lane_hub("");
    let repo = work.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "1").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "one"]);
    start(&mut hub);
    open(
        &hub,
        "c-fail",
        &json!({ "checks": [{ "kind": "command", "argv": ["false"] }] }),
    );
    open(&hub, "c-git", &json!({ "cwd": repo }));
    std::fs::write(repo.join("a.txt"), "2").unwrap();
    for key in ["c-fail", "c-git"] {
        let out = lane(
            &hub,
            "claim",
            &json!({ "key": key, "evidence": "report 1" }),
        )
        .unwrap();
        assert!(out.as_str().unwrap().contains("closes at"));
    }
    let rejected = |key: &str| {
        hub.until(WAIT, || {
            let r = record(&hub, key);
            (r["state"] == "rejected").then_some(r)
        })
    };
    let failed = rejected("c-fail");
    assert!(
        failed["objection"].to_string().contains("check failed"),
        "{failed}"
    );
    let unsent = rejected("c-git");
    assert!(
        unsent["objection"].to_string().contains("unsent work"),
        "{unsent}"
    );
    // An unopposed claim closes by itself after the window.
    open(&hub, "c-ok", &json!({}));
    lane(
        &hub,
        "claim",
        &json!({ "key": "c-ok", "evidence": "report 1" }),
    )
    .unwrap();
    let closed = hub.until(WAIT, || {
        let r = record(&hub, "c-ok");
        (r["state"] == "closed").then_some(r)
    });
    assert_eq!(closed["outcome"], "completed");
    reopen_leaves_the_claim_notice_behind(&hub, &closed);
    // A crash right after the close intent: the next hub finishes the close.
    open(&hub, "c-crash", &json!({}));
    hub.stop();
    hub.env.push((
        "CATALY_FAULT".into(),
        PathBuf::from("lane_after_close_intent"),
    ));
    start(&mut hub);
    hub.until(WAIT, || {
        (record(&hub, "c-crash")["live"] == true).then_some(())
    });
    let _ = lane(&hub, "close", &json!({ "key": "c-crash", "note": "done" }));
    hub.wait_exit(WAIT);
    hub.env.clear();
    start(&mut hub);
    let done = hub.until(WAIT, || {
        let r = record(&hub, "c-crash");
        (r["state"] == "closed").then_some(r)
    });
    assert_eq!(done["outcome"], "completed");
    assert!(
        done["receipt"].to_string().contains("pass command true"),
        "{done}"
    );
    hub.stop();
}

/// Check 5: pause confirms the goal paused first; resume restores; a held lane that starts a turn
/// stays held and the lead hears it once per active stretch. A held lane's goal is paused, so the
/// hub delivers nothing into it (HOST req. 50): the owner's thread message waits in the lane's inbox
/// until the resume, and the turn a held lane starts is its own (a background job's result).
#[test]
fn pause_resume_and_a_held_lane_that_turns() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.thread(THREAD, CH);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    start(&mut hub);
    open(
        &hub,
        "p-1",
        &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
    );
    let rec = record(&hub, "p-1");
    let id = rec["session_id"].as_str().unwrap();
    let session_file = || std::fs::read_to_string(rec["session_file"].as_str().unwrap()).unwrap();
    assert_eq!(goal(&hub, &rec["session_id"]), "active");
    lane(
        &hub,
        "pause",
        &json!({ "key": "p-1", "reason": "owner said wait" }),
    )
    .unwrap();
    let held = record(&hub, "p-1");
    assert_eq!(
        (held["state"].clone(), goal(&hub, &rec["session_id"])),
        (json!("held"), "paused".to_string())
    );
    // The owner writes in the lane's thread: the message is the lane's and waits while it is held.
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["healthy"] == true).then_some(())
    });
    fake.say(FakeDiscord::message(
        THREAD,
        700_000_000_000_000_001,
        OWNER,
        "how is it going?",
    ));
    hub.until(WAIT, || {
        (hub.json(&["discord", "status", "--json"])["counts"]["answers_waiting"] == 1).then_some(())
    });
    // The held lane turns by itself: it stays held, the lead hears it once for the stretch.
    let held_alerts = || {
        events_of(&hub, "lane.alert")
            .into_iter()
            .filter(|e| e["text"].as_str().unwrap().contains("held lane active"))
            .count()
    };
    std::fs::write(data(&hub).join(format!("background-{id}")), "").unwrap();
    hub.until(WAIT, || (held_alerts() == 1).then_some(()));
    hub.until(WAIT, || {
        session_file()
            .contains("background result read")
            .then_some(())
    });
    assert_eq!(record(&hub, "p-1")["state"], "held");
    assert_eq!(goal(&hub, &rec["session_id"]), "paused");
    assert!(
        !session_file().contains("how is it going?"),
        "nothing is delivered into a held lane"
    );
    // The next stretch after it went idle is reported again.
    std::thread::sleep(Duration::from_secs(1));
    std::fs::write(data(&hub).join(format!("background-{id}")), "").unwrap();
    hub.until(WAIT, || (held_alerts() == 2).then_some(()));
    lane(&hub, "resume", &json!({ "key": "p-1" })).unwrap();
    let back = record(&hub, "p-1");
    assert_eq!(
        (back["state"].clone(), goal(&hub, &rec["session_id"])),
        (json!("running"), "active".to_string())
    );
    hub.until(WAIT, || {
        session_file().contains("how is it going?").then_some(())
    });
    hub.stop();
}

/// Check 6: park, then reopen on the exact file with a new run ID; a header naming another session
/// refuses the reopen.
#[test]
fn park_and_reopen_on_the_exact_session() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "k-1", &json!({}));
    open(&hub, "k-2", &json!({}));
    let before = record(&hub, "k-1");
    let parked = lane(
        &hub,
        "park",
        &json!({ "key": "k-1", "reason": "waiting for review", "condition": "PR approved" }),
    )
    .unwrap();
    assert_eq!(parked, json!("closed parked"));
    let rec = record(&hub, "k-1");
    assert_eq!(
        (
            rec["state"].clone(),
            rec["outcome"].clone(),
            rec["live"].clone()
        ),
        (json!("closed"), json!("parked"), json!(false))
    );
    lane(
        &hub,
        "reopen",
        &json!({ "key": "k-1", "note": "review is in" }),
    )
    .unwrap();
    let after = record(&hub, "k-1");
    assert_eq!(after["state"], "running");
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["session_file"], before["session_file"]);
    assert_ne!(after["run_id"], before["run_id"]);
    lane(&hub, "park", &json!({ "key": "k-2", "reason": "later" })).unwrap();
    let k2 = record(&hub, "k-2");
    let path = k2["session_file"].as_str().unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let forged = text.replacen(
        k2["session_id"].as_str().unwrap(),
        "00000000-0000-0000-0000-000000000000",
        1,
    );
    std::fs::write(path, forged).unwrap();
    let refused = lane(&hub, "reopen", &json!({ "key": "k-2" })).unwrap_err();
    assert!(refused.contains("another session"), "{refused}");
    hub.stop();
}

/// Check 7: shell rules through the bridge link: blocks name rule numbers and a digest only; a
/// one-attempt grant is used up by the next identical command.
#[test]
fn shell_rules_block_and_grants_are_one_attempt() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "s-1", &json!({}));
    let rec = record(&hub, "s-1");
    let (mut b, answer) = hello(&hub, &rec);
    assert_eq!(answer["shell"], true);
    let shell = |b: &mut Bridge, command: &str| {
        b.call(
            "bridge.shell",
            json!({ "tool": "bash", "command": command, "session": rec["session_id"] }),
        )
    };
    assert_eq!(shell(&mut b, "ls -la")["allow"], true);
    let blocked = shell(&mut b, "git push origin main");
    assert_eq!(blocked["allow"], false);
    let reason = blocked["reason"].as_str().unwrap();
    assert!(
        reason.contains("rule 1") && reason.contains("sha256") && !reason.contains("origin main"),
        "{reason}"
    );
    // The lane's own tool named in bash is refused with a pointer to the direct call (DESIGN 12.2
    // A13); the tool name by path is judged by the rules as usual.
    let report = "cataly_lane report --kind progress --text 'ready' 2>&1 | head -5";
    for line in [report.to_string(), format!("ls; {report}")] {
        let refused = shell(&mut b, &line).to_string();
        let pointer = "\"allow\":false,\"reason\":\"No command ran: cataly_lane is a tool";
        assert!(refused.contains(pointer), "{refused}");
    }
    let by_path = shell(&mut b, "/tmp/cataly_lane report --text 'git push'").to_string();
    assert!(by_path.contains("rule 1"), "{by_path}");
    assert_eq!(shell(&mut b, "omp usage reset")["allow"], false);
    assert!(
        lane(
            &hub,
            "grant",
            &json!({ "key": "s-1", "rule": 0, "reason": "x" })
        )
        .is_err(),
        "rule 0 is never granted"
    );
    shell(&mut b, "git push origin main");
    lane(
        &hub,
        "grant",
        &json!({ "key": "s-1", "rule": 1, "reason": "owner approved the push" }),
    )
    .unwrap();
    assert_eq!(
        shell(&mut b, "git push origin main")["allow"],
        true,
        "the grant allows one attempt"
    );
    assert_eq!(
        shell(&mut b, "git push origin main")["allow"],
        false,
        "and is used up"
    );
    assert_eq!(
        b.call("bridge.shell", json!({ "tool": "bash", "command": 7 }))["allow"],
        false,
        "no command string"
    );
    // A subagent spawn needs the session on disk (EXT req. 34).
    assert_eq!(
        b.call("bridge.shell", json!({ "tool": "task", "saved": false }))["allow"],
        false
    );
    assert_eq!(
        b.call("bridge.shell", json!({ "tool": "task", "saved": true }))["allow"],
        true
    );
    // The model barrier: the pin or the fallback OMP announced passes; anything else holds the turn.
    let model = |b: &mut Bridge, facts: Value| b.call("bridge.model", facts)["allow"].clone();
    assert_eq!(model(&mut b, json!({ "model": "fake/Primary" })), true);
    assert_eq!(model(&mut b, json!({ "model": "fake/other" })), false);
    assert_eq!(
        model(
            &mut b,
            json!({ "model": "fake/other", "fallback": "fake/other:high" })
        ),
        true
    );
    hub.until(WAIT, || {
        events_of(&hub, "lane.alert")
            .iter()
            .any(|e| {
                e["text"]
                    .as_str()
                    .unwrap()
                    .contains("pinned fake/primary; OMP is on fake/other")
            })
            .then_some(())
    });
    // A session that belongs to no open lane is blocked.
    lane(
        &hub,
        "abandon",
        &json!({ "key": "s-1", "reason": "done with it" }),
    )
    .unwrap();
    assert_eq!(shell(&mut b, "ls")["allow"], false);
    hub.stop();
}

/// Check 8: reminders while idle, one stall alert, the cost ceiling holds the lane and reaches OMP as
/// `--max-cost`.
#[test]
fn oversight_reminds_alerts_once_and_holds_at_the_ceiling() {
    let (mut hub, _) = lane_hub(
        "[lanes.oversight]\nfirst_reminder = \"2s\"\nsecond_reminder = \"3s\"\nstall = \"8s\"\nsweep = \"1s\"\n",
    );
    start(&mut hub);
    let opened = Instant::now();
    open(&hub, "o-1", &json!({}));
    let rec = record(&hub, "o-1");
    let file = PathBuf::from(rec["session_file"].as_str().unwrap());
    let reminders = |_: &TestHub| {
        std::fs::read_to_string(&file)
            .unwrap_or_default()
            .matches("[reminder ")
            .count()
    };
    hub.until(WAIT, || (reminders(&hub) >= 2).then_some(()));
    let stall = hub.until(WAIT, || {
        let s: Vec<Value> = events_of(&hub, "lane.alert")
            .into_iter()
            .filter(|e| e["text"].as_str().unwrap().contains(" stall: "))
            .collect();
        (!s.is_empty()).then_some(s)
    });
    assert!(opened.elapsed() >= Duration::from_secs(8));
    std::thread::sleep(Duration::from_secs(4));
    assert_eq!(reminders(&hub), 2, "no third reminder");
    let stalls = events_of(&hub, "lane.alert")
        .into_iter()
        .filter(|e| e["text"].as_str().unwrap().contains(" stall: "))
        .count();
    assert_eq!((stalls, stall.len()), (1, 1), "one stall alert per round");
    // Cost ceiling: on the command line, and reaching it holds the lane.
    open(&hub, "o-2", &json!({ "ceilings": { "cost": 0.5 } }));
    let argv = std::fs::read_to_string(data(&hub).join("argv")).unwrap();
    assert!(argv.contains("--max-cost=0.5"), "{argv}");
    let r2 = record(&hub, "o-2");
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(r2["session_file"].as_str().unwrap())
        .unwrap();
    writeln!(
        f,
        r#"{{"type":"message","id":"u1","message":{{"role":"assistant","content":[],"usage":{{"input":10,"output":5,"cost":{{"total":0.75}}}}}}}}"#
    )
    .unwrap();
    let held = hub.until(WAIT, || {
        let r = record(&hub, "o-2");
        (r["state"] == "held").then_some(r)
    });
    assert_eq!(held["held_by"], "oversight");
    assert!(held["reason"].as_str().unwrap().contains("ceiling reached"));
    assert_eq!(goal(&hub, &r2["session_id"]), "paused");
    hub.stop();
}

/// Check 9: stuck and finished reports post to the thread at once, progress by the quiet rule;
/// paths are cleaned; each report posts at most once.
#[test]
fn reports_reach_the_thread_by_policy() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("[lanes.oversight]\nthread_quiet = \"3s\"\nsweep = \"1s\"\n");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    fake.thread(THREAD, CH);
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!("{config}{}", fake.config(&token, OWNER, &[CH])));
    start(&mut hub);
    open(
        &hub,
        "t-1",
        &json!({ "thread": format!("discord:{THREAD}"), "cwd": work }),
    );
    let rec = record(&hub, "t-1");
    let (mut b, _) = hello(&hub, &rec);
    let home = hub.root.join("home");
    let posts = || fake.bot_messages(THREAD);
    b.lane_tool(
        "p1",
        &rec["session_id"],
        json!({ "op": "report", "kind": "progress", "text": "halfway" }),
    );
    std::thread::sleep(Duration::from_secs(1));
    assert!(posts().is_empty(), "progress waits for the quiet rule");
    let progress = fake.wait(WAIT, |f| {
        let p = f.bot_messages(THREAD);
        (!p.is_empty()).then_some(p)
    });
    assert!(progress[0]["content"].as_str().unwrap().contains("halfway"));
    let stuck = format!(
        "blocked on {}/notes.txt and /etc/hosts, see https://ci.example/run?id=7",
        home.display()
    );
    b.lane_tool(
        "p2",
        &rec["session_id"],
        json!({ "op": "report", "kind": "stuck", "text": stuck }),
    );
    let second = hub.until(WAIT, || {
        let p = posts();
        (p.len() >= 2).then_some(p)
    });
    let text = second[1]["content"].as_str().unwrap();
    assert!(text.starts_with("Lane update:"), "{text}");
    assert!(
        text.contains("~/notes.txt and [path removed], see")
            && text.ends_with("https://ci.example/run"),
        "{text}"
    );
    assert!(!text.contains("id=7"));
    // A progress report a later one superseded is never sent: the quiet rule sends the last (WS req. 14).
    b.lane_tool(
        "p3",
        &rec["session_id"],
        json!({ "op": "report", "kind": "progress", "text": "superseded" }),
    );
    b.lane_tool(
        "p4",
        &rec["session_id"],
        json!({ "op": "report", "kind": "finished", "text": "all done" }),
    );
    hub.until(WAIT, || (posts().len() >= 3).then_some(()));
    std::thread::sleep(Duration::from_secs(4));
    let all = posts();
    assert_eq!(all.len(), 3, "each report posts at most once: {all:?}");
    assert!(all[2]["content"].as_str().unwrap().contains("all done"));
    let reports = lane(&hub, "reports", &json!({ "key": "t-1" })).unwrap();
    let relay: Vec<(String, String)> = reports
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["text"].as_str().unwrap().to_string(),
                r["relay"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        relay.iter().filter(|(_, r)| r == "posted").count(),
        3,
        "{reports}"
    );
    assert!(
        relay
            .iter()
            .any(|(t, r)| t == "superseded" && r == "not posted"),
        "{reports}"
    );
    hub.stop();
}

/// Check 10 (decision 9): three running lanes, two with active goals and one paused by the lead, are
/// restarted on their exact files after a hub restart; the two get `goal resume`, the paused one
/// stays paused, the lead receives the recap.
#[test]
fn hub_restart_brings_lanes_back_on_their_files() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    for key in ["a-1", "a-2", "a-3"] {
        open(&hub, key, &json!({}));
    }
    lane(
        &hub,
        "pause",
        &json!({ "key": "a-3", "reason": "owner said wait" }),
    )
    .unwrap();
    let before: Vec<Value> = ["a-1", "a-2", "a-3"]
        .iter()
        .map(|k| record(&hub, k))
        .collect();
    hub.stop();
    start(&mut hub);
    let after: Vec<Value> = hub.until(WAIT, || {
        let r: Vec<Value> = ["a-1", "a-2", "a-3"]
            .iter()
            .map(|k| record(&hub, k))
            .collect();
        r.iter().all(|x| x["live"] == true).then_some(r)
    });
    for (b, a) in before.iter().zip(&after) {
        assert_eq!(a["session_id"], b["session_id"], "{a}");
        assert_eq!(a["session_file"], b["session_file"]);
    }
    hub.until(WAIT, || {
        (goal(&hub, &after[1]["session_id"]) == "active").then_some(())
    });
    assert_eq!(goal(&hub, &after[0]["session_id"]), "active");
    assert_eq!(goal(&hub, &after[2]["session_id"]), "paused");
    assert_eq!(after[2]["state"], "held");
    let recap = hub.until(WAIT, || {
        let r = events_of(&hub, "lane.recap");
        (!r.is_empty()).then_some(r)
    });
    let text = recap[0]["text"].as_str().unwrap();
    assert!(text.contains("a-3: restarted; stays held"), "{text}");
    assert!(text.contains("a-1: restarted; goal active"), "{text}");
    hub.stop();
}

/// Hub CPU time (user plus system clock ticks) from `/proc`.
fn cpu_ticks(pid: u32) -> u64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let after = stat.rsplit_once(')').unwrap().1;
    let fields: Vec<&str> = after.split_whitespace().collect();
    fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap()
}

/// Slice-3a measurement: hub CPU with eight idle open lanes over two minutes, scaled to an hour
/// (oversight sweeps, spend reads, watches). Run with `cargo test --release --test lanes --
/// --ignored --nocapture oversight_cpu`.
#[test]
#[ignore = "measurement"]
fn oversight_cpu_with_eight_lanes() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    for n in 0..8 {
        open(&hub, &format!("cpu-{n}"), &json!({}));
    }
    std::thread::sleep(Duration::from_secs(5));
    let window = Duration::from_secs(120);
    let before = cpu_ticks(hub.pid());
    std::thread::sleep(window);
    let used = cpu_ticks(hub.pid()) - before;
    // Linux clock ticks are 100 per second.
    let per_hour = f64::from(u32::try_from(used).unwrap()) / 100.0 * 3600.0 / window.as_secs_f64();
    eprintln!("MEASURE oversight_cpu_8_lanes ticks={used} per_hour_s={per_hour:.2}");
    hub.stop();
}

/// The lead's bridge, connected with the lead session's launch token.
fn lead_bridge(hub: &TestHub) -> (Bridge, Value) {
    let session = hub.until(WAIT, || {
        let v = hub.json(&["lead", "status", "--json"]);
        (v["phase"] == "live").then(|| v["session"]["session_id"].clone())
    });
    let (bridge, hello) = Bridge::connect(
        hub,
        json!({ "ext": 1, "token": token(hub, &session), "session": session, "agent": "main" }),
    );
    (bridge, json!({ "hello": hello, "session": session }))
}

fn lead_tool(bridge: &mut Bridge, session: &Value, call: &str, input: Value) -> (String, bool) {
    let mut params = json!({ "call": call, "tool": "cataly_lead", "session": session });
    params["input"] = input;
    let v = bridge.call("bridge.tool", params);
    (
        v["text"].as_str().unwrap_or_default().to_string(),
        v["error"] == true,
    )
}

/// Milestone 7 check 8: onboarding asks one consent question before reading anything (no tool is
/// recorded before it), a "no" is stored and not asked again (also after a restart), and messenger
/// writes from the lead (tool posts and `cataly` commands in its shell) are refused while it runs.
#[test]
fn onboarding_consent_is_stored_and_writes_wait() {
    let (mut hub, work) = lane_hub("");
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{text}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        work.display()
    ));
    start(&mut hub);
    let (mut b, meta) = lead_bridge(&hub);
    assert_eq!(meta["hello"]["role"], "lead");
    assert_eq!(meta["hello"]["shell"], true);
    let s = meta["session"].clone();
    let (state, _) = lead_tool(&mut b, &s, "o1", json!({ "op": "onboarding" }));
    assert!(state.contains("\"phase\":\"new\""), "{state}");
    let (_, err) = lead_tool(&mut b, &s, "o2", json!({ "op": "onboarding.start" }));
    assert!(!err);
    // Nothing is read before the consent answer.
    let early = json!({ "op": "onboarding.tool", "name": "mail", "answer": "allowed", "reads": "subjects", "message": "m1" });
    let (_, err) = lead_tool(&mut b, &s, "o3", early);
    assert!(err, "a tool before consent is refused");
    // Writes wait while onboarding runs.
    let ask = json!({ "op": "question.ask", "text": "Which?", "source": "discord:1:2", "options": ["a", "b"] });
    let (why, err) = lead_tool(&mut b, &s, "o4", ask.clone());
    assert!(err && why.contains("onboarding"), "{why}");
    let (why, err) = lead_tool(&mut b, &s, "o5", json!({ "op": "lane.open", "key": "k" }));
    assert!(err && why.contains("onboarding"), "{why}");
    let (why, _) = lead_tool(&mut b, &s, "o6", json!({ "op": "lane.list" }));
    assert!(!why.contains("onboarding"), "reads stay allowed: {why}");
    let shell = |b: &mut Bridge, command: &str| {
        b.call(
            "bridge.shell",
            json!({ "tool": "bash", "command": command, "session": s }),
        )
    };
    let refused = shell(&mut b, "cataly lead send hello");
    assert_eq!(refused["allow"], false);
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("cataly_lead tool"),
        "{refused}"
    );
    // The lead's own tool named in bash (the owner's line) is refused with a pointer to the direct
    // call, which is the only form OMP offers (DESIGN 12.2 A13).
    let own = shell(
        &mut b,
        "cataly_lead onboarding.start 2>&1; echo ---; cataly_lead requests",
    );
    assert_eq!(own["allow"], false);
    assert!(
        own["reason"]
            .as_str()
            .unwrap()
            .contains("Call cataly_lead directly as a tool call"),
        "{own}"
    );
    assert_eq!(
        shell(&mut b, "/usr/bin/cataly slack upload T1/C1 /tmp/x")["allow"],
        false
    );
    assert_eq!(shell(&mut b, "ls ~/.config")["allow"], true);
    // A "no" is stored and ends onboarding; it is not asked again.
    let no = json!({ "op": "onboarding.consent", "answer": "no", "message": "owner-msg-1" });
    let (_, err) = lead_tool(&mut b, &s, "o7", no);
    assert!(!err);
    let (why, err) = lead_tool(&mut b, &s, "o8", json!({ "op": "onboarding.start" }));
    assert!(err && why.contains("declined"), "{why}");
    let (why, _) = lead_tool(&mut b, &s, "o9", ask);
    assert!(
        !why.contains("onboarding"),
        "writes are allowed again: {why}"
    );
    // Onboarding has ended, but rule 0 still refuses the lead's own mutating `cataly` command
    // (DESIGN 9.2); reads pass.
    assert_eq!(shell(&mut b, "cataly lead send hello")["allow"], false);
    assert_eq!(shell(&mut b, "cataly status")["allow"], true);
    drop(b);
    hub.stop();
    start(&mut hub);
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    let (why, err) = lead_tool(&mut b, &s, "p1", json!({ "op": "onboarding.start" }));
    assert!(
        err && why.contains("declined"),
        "kept across a restart: {why}"
    );
    let (state, _) = lead_tool(&mut b, &s, "p2", json!({ "op": "onboarding" }));
    assert!(state.contains("\"consent\":\"no\""), "{state}");
    let reopen = json!({ "op": "onboarding.start", "reopen": true, "message": "owner-msg-2" });
    let (_, err) = lead_tool(&mut b, &s, "p3", reopen);
    assert!(!err, "the owner may raise it again");
    drop(b);
    hub.stop();
}

/// Issue 278: the owner's name answer lands in the config file (and still loads), and an image he
/// attached is applied to the bot and the application and recorded so setup keeps it. Both wait
/// for onboarding to start, and a refused avatar leaves Discord untouched.
#[test]
fn onboarding_name_and_avatar_are_written_applied_and_recorded() {
    let fake = FakeDiscord::start();
    let (mut hub, work) = lane_hub("");
    let token = hub.private_file("token", "fake-token");
    fake.channel(CH, 0, None);
    let text = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{text}[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n{}",
        work.display(),
        fake.config(&token, OWNER, &[CH])
    ));
    start(&mut hub);
    let (mut b, meta) = lead_bridge(&hub);
    let s = meta["session"].clone();
    let name = json!({ "op": "onboarding.name", "name": "Mi", "message": "m1" });
    let (why, err) = lead_tool(&mut b, &s, "n0", name.clone());
    assert!(err && why.contains("onboarding.start"), "{why}");
    assert!(
        !std::fs::read_to_string(hub.config_path())
            .unwrap()
            .contains("name = ")
    );
    lead_tool(&mut b, &s, "n1", json!({ "op": "onboarding.start" }));

    let (why, err) = lead_tool(&mut b, &s, "n2", name);
    assert!(!err, "{why}");
    let after = std::fs::read_to_string(hub.config_path()).unwrap();
    assert!(
        after.contains("[lead]\nmodel = \"fake/primary\""),
        "{after}"
    );
    assert!(after.contains("name = \"Mi\""), "{after}");
    let check = hub.cli(&["config", "check"]);
    assert!(check.status.success(), "{check:?}");
    let persona =
        json!({ "op": "onboarding.persona", "persona": "dry wit, short", "message": "m2" });
    let (why, err) = lead_tool(&mut b, &s, "n3", persona);
    assert!(!err, "{why}");
    assert!(
        std::fs::read_to_string(hub.config_path())
            .unwrap()
            .contains("persona = \"dry wit, short\"")
    );
    let multi = json!({ "op": "onboarding.name", "name": "a\nb", "message": "m3" });
    assert!(lead_tool(&mut b, &s, "n4", multi).1);

    // Not an image: nothing reaches Discord.
    let page = fake.serve_file("page", b"<html>sign in</html>");
    let bad = json!({ "op": "onboarding.avatar", "url": page, "message": "m4" });
    let (why, err) = lead_tool(&mut b, &s, "a0", bad);
    assert!(
        err && why.contains("HTML") && why.contains("JPEG, PNG or GIF"),
        "{why}"
    );
    assert!(fake.calls("PATCH", "/users/@me").is_empty());
    // An image: the bot's avatar and the application's icon are set and recorded.
    let png = [&[0x89, b'P', b'N', b'G', 13, 10, 26, 10][..], &[7u8; 64]].concat();
    let url = fake.serve_file("me.png", &png);
    let good = json!({ "op": "onboarding.avatar", "url": url, "message": "m5" });
    let (why, err) = lead_tool(&mut b, &s, "a1", good);
    assert!(!err, "{why}");
    let users = fake.calls("PATCH", "/users/@me");
    let apps = fake.calls("PATCH", "/applications/@me");
    assert_eq!((users.len(), apps.len()), (1, 1));
    let data = users[0].body["avatar"].as_str().unwrap();
    assert!(
        data.starts_with("data:image/png;base64,iVBORw0KGgo"),
        "{data}"
    );
    assert_eq!(apps[0].body["icon"], users[0].body["avatar"]);
    let (avatar, _) = fake.image("avatar").unwrap();
    let (icon, _) = fake.image("icon").unwrap();
    let record: Value =
        serde_json::from_slice(&std::fs::read(hub.state().join("discord-profile.json")).unwrap())
            .unwrap();
    assert_eq!(record["bot"], support::discord::BOT);
    assert_eq!(record["avatar"]["hash"], avatar);
    assert_eq!(record["icon"]["hash"], icon);
    assert_eq!(record["avatar"]["image"].as_str().unwrap().len(), 64);
    assert_eq!(record["avatar"]["image"], record["icon"]["image"]);
    let (state, _) = lead_tool(&mut b, &s, "a2", json!({ "op": "onboarding" }));
    assert!(state.contains("\"phase\":\"running\""), "{state}");
    drop(b);
    hub.stop();
}

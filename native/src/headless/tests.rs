//! End-to-end host runs against `fake_omp.py`, a fake OMP speaking pinned `rpc-ui` v1, through the Rust client.

use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::http::client::request_host;
use super::record::{Entry, lane_entry, write_private};
use super::*;
use crate::util::{iso, now_ms, uuid};

struct Lane {
    home: PathBuf,
    entry: Entry,
    trace: PathBuf,
    saved: PathBuf,
    id: String,
    start: Vec<u8>,
}

impl Lane {
    /// A reserved lane (`HeadlessRuntime.create`) and the start record its launcher would stream.
    fn reserve(role: &str, version: &str) -> Self {
        let home = std::env::temp_dir().join(format!("cataly-host-{}", uuid().unwrap()));
        let state = home.join("state");
        let id = uuid().unwrap();
        let dir = state.join("headless").join(&id);
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .unwrap();
        let work = home.join("work");
        fs::create_dir(&work).unwrap();
        let cwd = fs::canonicalize(&work)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        write_private(
            &dir.join("reservation.json"),
            &Json::object(vec![
                (
                    "ref",
                    Json::object(vec![
                        ("runtime", Json::string("headless")),
                        ("id", Json::string(&id)),
                    ]),
                ),
                ("cwd", Json::string(&cwd)),
                ("name", Json::string("native work")),
                ("role", Json::string(role)),
                ("startedAt", Json::string(&iso(now_ms() - 1000))),
            ]),
        )
        .unwrap();
        let omp = home.join("omp.py");
        fs::write(&omp, include_str!("fake_omp.py")).unwrap();
        fs::set_permissions(&omp, fs::Permissions::from_mode(0o700)).unwrap();
        let trace = home.join("trace.jsonl");
        let saved = home.join("saved.jsonl");
        let mut env = json!({
            "PATH": std::env::var("PATH").unwrap_or_default(),
            "CATALY_TEST_TRACE": trace,
            "CATALY_TEST_SESSION": saved,
            "FAKE_OMP_VERSION": version,
        });
        if role != "lane" {
            env["CATALY_HARNESS_ROLE"] = Value::from(role);
        }
        let argv = [omp.to_str().unwrap(), "--model", "fixture/initial", role];
        let start = serde_json::to_vec(&json!({ "argv": argv, "env": env })).unwrap();
        let entry = lane_entry(&state, &id).unwrap().unwrap();
        Self {
            home,
            entry,
            trace,
            saved,
            id,
            start,
        }
    }

    /// Selects a `FAKE_SCENARIO` of `fake_omp.py`.
    fn scenario(mut self, name: &str) -> Self {
        let mut start: Value = serde_json::from_slice(&self.start).unwrap();
        start["env"]["FAKE_SCENARIO"] = Value::from(name);
        self.start = serde_json::to_vec(&start).unwrap();
        self
    }

    /// Sends SIGTERM to the fake OMP, which then exits 143.
    fn kill_omp(&self) {
        let launch: Value = serde_json::from_str(&self.frames()[0]).unwrap();
        let status = std::process::Command::new("kill")
            .arg(launch["pid"].to_string())
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn dir(&self) -> &Path {
        &self.entry.dir
    }

    /// Runs the host as `cataly headless-host <dir>` would after reading the start record.
    fn spawn(&self) -> tokio::task::JoinHandle<Result<()>> {
        let dir = self.dir().to_owned();
        let start = self.start.clone();
        tokio::spawn(async move {
            let reservation = admit(&dir)?;
            serve(&dir, reservation, &start).await
        })
    }

    async fn request(&self, request: Value) -> Result<Json> {
        let request: Json = serde_json::from_value(request).unwrap();
        request_host(&self.entry, &request).await
    }

    /// Polls `observe` until `ready` accepts the observation.
    async fn until(&self, ready: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            if self.dir().join("endpoint.json").exists()
                && let Ok(seen) = self.request(json!({"op": "observe"})).await
            {
                let seen: Value = serde_json::from_str(&seen.compact()).unwrap();
                if ready(&seen) {
                    return seen;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("headless host never reached the expected observation");
    }

    fn frames(&self) -> Vec<String> {
        fs::read_to_string(&self.trace)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn stopped(&self) -> String {
        fs::read_to_string(self.dir().join("stopped.json")).unwrap()
    }
}

impl Drop for Lane {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.home));
    }
}

fn keys(value: &Json) -> Vec<&str> {
    match value {
        Json::Object(fields) => fields.iter().map(|(key, _)| key.as_str()).collect(),
        _ => Vec::new(),
    }
}

/// A lead session whose `get_entries` reply is past 1 MiB: only a chunked v2 frame can carry the role proof.
#[tokio::test]
async fn a_large_session_proves_its_role_over_chunked_entries() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &format!("omp {version}")).scenario("huge-entries");
    let host = lane.spawn();
    let seen = lane
        .until(|seen| seen["status"] == "idle" && seen["sessionId"].is_string())
        .await;
    assert_eq!(seen["role"], "lane");
    lane.kill_omp();
    host.await.unwrap().unwrap();
}

/// The same session against an OMP that refuses v2: resumed nowhere, so the lane never proves itself.
#[tokio::test]
async fn a_large_session_without_v2_never_proves_its_role() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &format!("omp {version}")).scenario("huge-entries-v1");
    let host = lane.spawn();
    let mut proven = false;
    for _ in 0..40 {
        if lane
            .request(json!({"op": "observe"}))
            .await
            .ok()
            .is_some_and(|seen| {
                let seen: Value = serde_json::from_str(&seen.compact()).unwrap_or(Value::Null);
                seen["status"] == "idle" && seen["sessionId"].is_string()
            })
        {
            proven = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!proven, "a v1-only OMP must not prove a >1 MiB session");
    // The refusal is OMP's answer to the proof request, not a skipped check.
    assert!(lane.trace.exists());
    let trace = fs::read_to_string(&lane.trace).unwrap();
    assert!(trace.contains("\"negotiate_protocol\""));
    assert!(trace.contains("\"get_entries\""));
    // The refused proof ends this lane's host by itself; there is no child left to signal.
    host.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_lane_observes_delivers_answers_and_closes() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &format!("omp {version}"));
    let host = lane.spawn();
    let seen = lane
        .until(|seen| seen["status"] == "idle" && seen["sessionId"].is_string())
        .await;
    let session = seen["sessionId"].as_str().unwrap().to_owned();
    let socket = assert_launch(&lane, &seen).await;
    let request_id = deliver_and_answer(&lane, &session).await;
    remote_commands(&lane, &session).await;
    close(&lane, host, &session, &socket).await;
    assert_frames(&lane, &request_id);
}

/// argv, env, cwd, pid, records and observation key order once the lane is proven.
async fn assert_launch(lane: &Lane, seen: &Value) -> PathBuf {
    let launch: Value = serde_json::from_str(&lane.frames()[0]).unwrap();
    let config = lane.dir().join("host.yml");
    assert_eq!(
        launch["argv"],
        json!([
            "--model",
            "fixture/initial",
            "lane",
            "--mode",
            "rpc-ui",
            "--approval-mode",
            "always-ask",
            "--config",
            config
        ])
    );
    assert_eq!(
        launch["env"],
        json!({"CATALY_HEADLESS_ID": lane.id, "PI_NOTIFICATIONS": "off", "CATALY_HARNESS_ROLE": null})
    );
    assert_eq!(launch["cwd"], seen["cwd"]);
    assert_eq!(
        seen["pid"], launch["pid"],
        "observation.pid is the OMP child"
    );
    assert_eq!(seen["role"], "lane");
    assert_eq!(seen["held"], false);
    assert_eq!(seen["sessionFile"], json!(lane.saved));
    assert_eq!(seen["goal"], json!({"status": "none"}));
    assert_eq!(seen["model"], "fixture/initial");
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "goal:\n  continuationModes: [rpc]\nask:\n  timeout: 0\n"
    );
    let endpoint = super::record::read_private(&lane.dir().join("endpoint.json"))
        .unwrap()
        .unwrap();
    assert_eq!(keys(&endpoint), ["socket", "key", "pid"]);
    assert_eq!(
        endpoint.get("pid"),
        Some(&Json::Number(std::process::id().into()))
    );
    let socket = PathBuf::from(endpoint.str("socket").unwrap());
    let observed = lane.request(json!({"op": "observe"})).await.unwrap();
    assert_eq!(
        keys(&observed),
        [
            "ref",
            "cwd",
            "startedAt",
            "updatedAt",
            "status",
            "held",
            "pid",
            "role",
            "sessionId",
            "sessionFile",
            "goal",
            "model",
            "dialogs",
            "recent"
        ]
    );
    socket
}

/// Delivery gates, slash wrapping, an approval dialog, refused grants and the single answer write.
async fn deliver_and_answer(lane: &Lane, session: &str) -> String {
    let delivered = lane
        .request(
            json!({"op": "deliver", "text": "hello", "options": {"expectedSessionId": session}}),
        )
        .await
        .unwrap();
    assert_eq!(
        delivered.compact(),
        r#"{"kind":"delivered","started":true}"#
    );
    let seen = lane
        .until(|seen| seen["recent"].as_array().is_some_and(|r| !r.is_empty()))
        .await;
    assert_eq!(
        seen["recent"],
        json!([{"kind": "assistant", "text": "hello"}])
    );
    let wrong = lane
        .request(json!({"op": "deliver", "text": "x", "options": {"expectedSessionId": "other"}}))
        .await
        .unwrap();
    assert_eq!(
        wrong.compact(),
        r#"{"kind":"not-ready","status":"unknown"}"#
    );
    lane.request(json!({"op": "deliver", "text": "/compact", "options": {}}))
        .await
        .unwrap();

    lane.request(json!({"op": "deliver", "text": "request approval", "options": {"expectedSessionId": session}}))
        .await
        .unwrap();
    let blocked = lane.until(|seen| seen["status"] == "blocked").await;
    assert_eq!(blocked["held"], true);
    let dialog = &blocked["dialogs"][0];
    assert_eq!(dialog["kind"], "approval");
    let request_id = dialog["id"].as_str().unwrap().to_owned();
    assert!(blocked["activeSince"].is_i64());
    let held = lane
        .request(json!({"op": "deliver", "text": "x", "options": {"expectedSessionId": session}}))
        .await
        .unwrap();
    assert_eq!(held.compact(), r#"{"kind":"not-ready","status":"blocked"}"#);
    let grant = lane
        .request(json!({"op": "answer", "expectedSessionId": session, "requestId": request_id, "answer": {"value": "Approve for this session"}}))
        .await
        .unwrap_err();
    assert_eq!(
        grant.to_string(),
        "no matching native dialog or unsupported answer"
    );
    let stale = lane
        .request(json!({"op": "answer", "expectedSessionId": "other", "requestId": request_id, "answer": {"value": "Approve Once"}}))
        .await
        .unwrap_err();
    assert_eq!(stale.to_string(), "native dialog session does not match");
    let answered = lane
        .request(json!({"op": "answer", "expectedSessionId": session, "requestId": request_id, "answer": {"value": "Approve Once"}}))
        .await
        .unwrap();
    assert_eq!(answered.compact(), r#"{"submitted":true}"#);
    let idle = lane.until(|seen| seen["status"] == "idle").await;
    assert_eq!(idle["dialogs"], json!([]));
    assert!(idle.get("activeSince").is_none());
    request_id
}

/// Remote admission receipts are idempotent per request ID; model changes read back.
async fn remote_commands(lane: &Lane, session: &str) {
    let submission = json!({"op": "remote-send", "expectedSessionId": session, "input": {"id": "r-1", "text": "remote"}});
    let receipt = lane.request(submission.clone()).await.unwrap().compact();
    assert_eq!(
        receipt,
        r#"{"id":"r-1","status":"admitted","replyAttributed":false,"receipt":{"id":"r-1","kind":"native-submission"}}"#
    );
    assert_eq!(lane.request(submission).await.unwrap().compact(), receipt);
    let changed = lane
        .request(json!({"op": "remote-send", "expectedSessionId": session, "input": {"id": "r-1", "text": "other"}}))
        .await
        .unwrap_err();
    assert_eq!(changed.to_string(), "Native request ID has different input");
    let unknown = lane
        .request(json!({"op": "remote-receipt", "expectedSessionId": session, "id": "r-2"}))
        .await
        .unwrap();
    assert_eq!(unknown, Json::Null);
    let model = lane
        .request(
            json!({"op": "remote-model", "expectedSessionId": session, "model": "fixture/next"}),
        )
        .await
        .unwrap();
    assert_eq!(
        model.compact(),
        r#"{"status":"changed","model":"fixture/next"}"#
    );
    let unsupported = lane.request(json!({"op": "stop-loop"})).await.unwrap_err();
    assert_eq!(unsupported.to_string(), "Unsupported headless operation");
}

/// `close` disconnects OMP; the host publishes `stopped.json` and removes its socket directory.
async fn close(
    lane: &Lane,
    host: tokio::task::JoinHandle<Result<()>>,
    session: &str,
    socket: &Path,
) {
    let closed = lane
        .request(json!({"op": "close", "expectedSessionId": session}))
        .await
        .unwrap();
    assert_eq!(closed.compact(), r#"{"closed":true}"#);
    // The reply follows the stop receipt, as Bun writes it before the close continuation resumes.
    assert_eq!(
        lane.stopped(),
        format!(r#"{{"closedSessionId":"{session}"}}"#)
    );
    host.await.unwrap().unwrap();
    assert!(
        !socket.parent().unwrap().exists(),
        "socket directory removed"
    );
}

/// The exact frames OMP received, in TypeScript key order.
fn assert_frames(lane: &Lane, request_id: &str) {
    let frames: Vec<Value> = lane.frames()[1..]
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let sent = |kind: &str| {
        frames
            .iter()
            .filter(|f| f["type"] == kind)
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(sent("set_ask_dialog").len(), 1);
    let prompts: Vec<Value> = sent("prompt")
        .iter()
        .map(|f| f["message"].clone())
        .collect();
    assert_eq!(
        prompts,
        ["hello", "[CATALY message]\n/compact", "request approval"]
    );
    let answers = sent("extension_ui_response");
    assert_eq!(answers.len(), 1, "a refused answer is never written");
    assert_eq!(
        lane.frames()
            .iter()
            .find(|line| line.contains("extension_ui_response"))
            .unwrap(),
        &format!(
            r#"{{"type":"extension_ui_response","id":"{request_id}","value":"Approve Once"}}"#
        )
    );
    assert_eq!(sent("follow_up")[0]["message"], "remote");
    assert_eq!(
        sent("set_model")[0],
        json!({"type": "set_model", "provider": "fixture", "modelId": "next", "id": sent("set_model")[0]["id"]})
    );
    let prompt = lane
        .frames()
        .into_iter()
        .find(|line| line.contains("\"hello\""))
        .unwrap();
    assert!(
        prompt.starts_with(
            r#"{"type":"prompt","message":"hello","streamingBehavior":"followUp","id":""#
        ),
        "{prompt}"
    );
}

#[tokio::test]
async fn a_lead_proves_its_harness_role_and_refuses_lane_controls() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lead", &version);
    let host = lane.spawn();
    let seen = lane
        .until(|seen| seen["status"] == "idle" && seen["sessionId"].is_string())
        .await;
    assert_eq!(seen["role"], "cataly");
    assert_eq!(seen["harnessRole"], "lead");
    let session = seen["sessionId"].as_str().unwrap().to_owned();
    let remote = lane
        .request(json!({"op": "remote-interrupt", "expectedSessionId": session}))
        .await
        .unwrap_err();
    assert_eq!(
        remote.to_string(),
        "native harness roles use the harness controls"
    );
    let goal = lane
        .request(json!({"op": "goal", "expectedSessionId": session, "target": "paused"}))
        .await
        .unwrap_err();
    assert_eq!(goal.to_string(), "harness role cannot change a lane goal");
    lane.request(json!({"op": "close", "expectedSessionId": session}))
        .await
        .unwrap();
    assert_eq!(
        lane.stopped(),
        format!(r#"{{"closedSessionId":"{session}"}}"#)
    );
    host.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_remote_close_replies_after_the_stop_receipt() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &version);
    let host = lane.spawn();
    let seen = lane
        .until(|seen| seen["status"] == "idle" && seen["sessionId"].is_string())
        .await;
    let session = seen["sessionId"].as_str().unwrap().to_owned();
    let closed = lane
        .request(json!({"op": "remote-close", "expectedSessionId": session, "force": false}))
        .await
        .unwrap();
    assert_eq!(closed.compact(), r#"{"status":"closed"}"#);
    assert_eq!(
        lane.stopped(),
        format!(r#"{{"closedSessionId":"{session}"}}"#)
    );
    host.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_wrong_omp_version_publishes_the_stop_receipt() {
    let lane = Lane::reserve("lane", "omp 0.0.0");
    lane.spawn().await.unwrap().unwrap();
    let version = rpc::required_version().unwrap();
    assert_eq!(
        lane.stopped(),
        format!(r#"{{"detail":"headless lanes require OMP {version}"}}"#)
    );
    assert!(!lane.trace.exists(), "rpc-ui never started");
}

#[test]
fn loop_roles_stay_on_bun() {
    let lane = Lane::reserve("duty-loop", "");
    assert_eq!(
        admit(lane.dir()).unwrap_err().to_string(),
        "headless-host serves lane, lead and duty; loop roles run on Bun"
    );
    assert!(!lane.dir().join("host.yml").exists());
}

#[tokio::test]
async fn an_unproven_session_cannot_answer_its_dialog() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &version).scenario("unproven-dialog");
    let host = lane.spawn();
    let seen = lane
        .until(|seen| {
            seen["dialogs"].as_array().is_some_and(|d| !d.is_empty()) && seen["detail"].is_string()
        })
        .await;
    assert_eq!(seen["dialogs"][0]["id"], "early");
    assert!(seen.get("sessionId").is_none(), "no identity was proven");
    for expected in [None, Some("anything")] {
        let mut answer =
            json!({"op": "answer", "requestId": "early", "answer": {"value": "Approve Once"}});
        if let Some(expected) = expected {
            answer["expectedSessionId"] = Value::from(expected);
        }
        let refused = lane.request(answer).await.unwrap_err();
        assert_eq!(refused.to_string(), "native dialog session does not match");
    }
    lane.kill_omp();
    host.await.unwrap().unwrap();
    assert_eq!(
        lane.stopped(),
        r#"{"detail":"OMP did not prove a stable persisted session with the Cataly lane role"}"#
    );
    assert!(
        !lane
            .frames()
            .iter()
            .any(|line| line.contains("extension_ui_response")),
        "nothing was answered"
    );
}

#[tokio::test]
async fn a_lone_surrogate_frame_keeps_the_lane_trustworthy() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &version);
    let host = lane.spawn();
    let seen = lane
        .until(|seen| seen["status"] == "idle" && seen["sessionId"].is_string())
        .await;
    let session = seen["sessionId"].as_str().unwrap().to_owned();
    lane.request(
        json!({"op": "deliver", "text": "surrogates", "options": {"expectedSessionId": session}}),
    )
    .await
    .unwrap();
    let seen = lane
        .until(|seen| seen["recent"].as_array().is_some_and(|r| !r.is_empty()))
        .await;
    assert_eq!(
        seen["recent"],
        json!([{"kind": "assistant", "text": "a\u{fffd} b\u{fffd} c\u{1f600}"}])
    );
    assert_eq!(seen["status"], "idle");
    assert!(seen.get("detail").is_none());
    lane.request(json!({"op": "close", "expectedSessionId": session}))
        .await
        .unwrap();
    host.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_stalled_omp_stdin_cannot_hold_the_host() {
    let version = rpc::required_version().unwrap();
    let lane = Lane::reserve("lane", &version);
    let host = lane.spawn();
    let seen = lane
        .until(|seen| seen["status"] == "idle" && seen["sessionId"].is_string())
        .await;
    let session = seen["sessionId"].as_str().unwrap().to_owned();
    lane.request(
        json!({"op": "deliver", "text": "deaf", "options": {"expectedSessionId": session}}),
    )
    .await
    .unwrap();
    // The readback succeeds, then OMP stops reading; this frame is far larger than a pipe buffer.
    let stuck = lane
        .request(json!({"op": "deliver", "text": "x".repeat(900_000), "options": {"expectedSessionId": session}}))
        .await
        .unwrap();
    assert_eq!(
        stuck.compact(),
        r#"{"kind":"ambiguous","detail":"OMP did not confirm the submitted input","failure":null}"#
    );
    let seen = lane.until(|seen| seen["status"] == "error").await;
    assert_eq!(
        seen["detail"],
        "OMP RPC stream disconnected or became untrustworthy"
    );
    lane.kill_omp();
    host.await.unwrap().unwrap();
    assert_eq!(
        lane.stopped(),
        r#"{"detail":"headless process exited (143)"}"#
    );
}

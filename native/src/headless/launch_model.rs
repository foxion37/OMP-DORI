//! Broker half of `src/runtime/headless-launch-model.ts` with `exactModelIdentity`/`expectedLaunchModel`
//! (`lane-state.ts`): the launch model bound in argv and the native extension's readback proof that gates `begin`.
//!
//! `beginNativeGoal` keeps its order in the broker: `begin_preflight`, `get_entries` + `read_launch_model`,
//! `check(session)`, `begin_verdict`, `goal {op:"create"}`, `goal_acknowledged`.

use serde::Serialize;
use serde_json::{Map, Value};

use super::protocol::{
    GoalStatus, NativeState, Observation, is_blank, is_js_space, last_custom_data, model_of,
};
use crate::util;

const LAUNCH_MODEL_OPTION: &str = "--cataly-launch-model=";
const HEADLESS_LAUNCH_MODEL_ENTRY: &str = "omp-cataly:headless-launch-model";
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// `launchModelFromArgv`: the last `--cataly-launch-model=` value, possibly empty (which `begin` treats as unbound).
pub(super) fn launch_model_from_argv(argv: &[String]) -> Option<&str> {
    argv.iter()
        .rev()
        .find_map(|arg| arg.strip_prefix(LAUNCH_MODEL_OPTION))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct ModelIdentity {
    pub(super) provider: String,
    pub(super) id: String,
}

/// `exactModelIdentity`: `/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([^\s*,]+)$/`.
fn exact_model_identity(value: &str) -> Option<ModelIdentity> {
    let (provider, id) = value.split_once('/')?;
    let mut head = provider.chars();
    let provider_ok = head.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && head.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    let id_ok = !id.is_empty() && !id.chars().any(|c| is_js_space(c) || c == '*' || c == ',');
    (provider_ok && id_ok).then(|| ModelIdentity {
        provider: provider.to_owned(),
        id: id.to_owned(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Thinking {
    requested: String,
    observed: String,
}

struct ExpectedModel {
    model: String,
    thinking: Option<Thinking>,
}

/// `thinkingSuffix`: OMP's case-sensitive trailing `:<level>`; any other colon suffix is part of a literal id.
fn thinking_suffix(id: &str) -> Option<(&str, &str)> {
    let at = id.rfind(':').filter(|&at| at > 0)?;
    let level = &id[at + 1..];
    THINKING_LEVELS.contains(&level).then(|| (&id[..at], level))
}

/// `expectedLaunchModel`: the model a matched readback must observe, given the proof's untrusted thinking record
/// (`None` = `undefined`).
fn expected_launch_model(model: &str, thinking: Option<&Value>) -> Option<ExpectedModel> {
    let Some(thinking) = thinking else {
        return Some(ExpectedModel {
            model: model.to_owned(),
            thinking: None,
        });
    };
    let (base, level) = thinking_suffix(model)?;
    let record = thinking.as_object()?;
    let same = |key: &str| record.get(key).and_then(Value::as_str) == Some(level);
    (same("requested") && same("observed")).then(|| ExpectedModel {
        model: base.to_owned(),
        thinking: Some(Thinking {
            requested: level.to_owned(),
            observed: level.to_owned(),
        }),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ReadbackStatus {
    Matched,
    Mismatch,
    Unknown,
    Unavailable,
}

impl ReadbackStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Matched => "matched",
            Self::Mismatch => "mismatch",
            Self::Unknown => "unknown",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Billing {
    Unknown,
    Subscription,
    NonSubscription,
}

/// `ModelReadback` as `launchModelOf` emits it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelReadback {
    requested: ModelIdentity,
    pub(super) observed: Option<ModelIdentity>,
    checked_at: String,
    pub(super) status: ReadbackStatus,
    billing: Billing,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Thinking>,
}

/// What the extension's proof must be bound to: this host, its session, the argv model and the reservation start.
pub(super) struct LaunchBinding<'a> {
    pub(super) ref_id: &'a str,
    pub(super) session_id: &'a str,
    pub(super) model: &'a str,
    pub(super) started_at: &'a str,
}

fn launch_model_of(
    entry: Option<&Map<String, Value>>,
    binding: &LaunchBinding<'_>,
) -> Option<ModelReadback> {
    let entry = entry?;
    let proof = entry.get("proof").and_then(Value::as_object)?;
    let text = |map: &Map<String, Value>, key: &str| {
        map.get(key).and_then(Value::as_str).map(str::to_owned)
    };
    let requested = exact_model_identity(binding.model)?;
    let observed = model_of(proof.get("observed"));
    let identity = observed.as_deref().and_then(exact_model_identity);
    let checked_at = text(proof, "checkedAt").filter(|at| !at.is_empty())?;
    let status = match proof.get("status").and_then(Value::as_str)? {
        "matched" => ReadbackStatus::Matched,
        "mismatch" => ReadbackStatus::Mismatch,
        "unknown" => ReadbackStatus::Unknown,
        "unavailable" => ReadbackStatus::Unavailable,
        _ => return None,
    };
    let billing = match proof.get("billing").and_then(Value::as_str)? {
        "unknown" => Billing::Unknown,
        "subscription" => Billing::Subscription,
        "non-subscription" => Billing::NonSubscription,
        _ => return None,
    };
    let fresh = util::parse_iso(&checked_at)
        .zip(util::parse_iso(binding.started_at))
        .is_some_and(|(checked, started)| checked >= started);
    if text(entry, "refId").as_deref() != Some(binding.ref_id)
        || text(entry, "sessionId").as_deref() != Some(binding.session_id)
        || model_of(proof.get("requested")).as_deref() != Some(binding.model)
        || proof.get("source").and_then(Value::as_str) != Some("native-extension")
        || !fresh
    {
        return None;
    }
    let expected = expected_launch_model(binding.model, proof.get("thinking"));
    let thinking = if status == ReadbackStatus::Matched {
        let expected = expected?;
        let observed = observed.filter(|_| identity.is_some())?;
        if observed.to_lowercase() != expected.model.to_lowercase() {
            return None;
        }
        expected.thinking
    } else {
        None
    };
    Some(ModelReadback {
        requested,
        observed: identity,
        checked_at,
        status,
        billing,
        source: "native-extension",
        thinking,
    })
}

/// `readLaunchModel` over a `get_entries` reply's data: the last launch-model entry's proof, if it binds this launch.
pub(super) fn read_launch_model(
    entries: Option<&Value>,
    binding: &LaunchBinding<'_>,
) -> Option<ModelReadback> {
    launch_model_of(
        last_custom_data(entries, HEADLESS_LAUNCH_MODEL_ENTRY).and_then(Value::as_object),
        binding,
    )
}

/// `beginNativeGoal`'s checks before any RPC.
pub(super) fn begin_preflight(
    expected_session_id: Option<&str>,
    model: Option<&str>,
) -> Result<(), &'static str> {
    if expected_session_id.is_none_or(str::is_empty) {
        return Err("native goal creation requires an exact session identity");
    }
    if model.is_none_or(str::is_empty) {
        return Err("STARTUP_MODEL_HOLD: no launch model bound; no goal created");
    }
    Ok(())
}

/// `beginNativeGoal`'s checks after the readback and `check(session)`; the readback to return on success.
pub(super) fn begin_verdict(
    readback: Option<ModelReadback>,
    state: &NativeState,
    objective: Option<&str>,
) -> Result<ModelReadback, String> {
    let readback = match readback {
        Some(readback) if readback.status == ReadbackStatus::Matched => readback,
        other => {
            let status = other.map_or("unconfirmed", |readback| readback.status.as_str());
            return Err(format!(
                "STARTUP_MODEL_HOLD: native launch model {status}; no goal created"
            ));
        }
    };
    let observed = readback
        .observed
        .as_ref()
        .map(|observed| format!("{}/{}", observed.provider, observed.id));
    if observed != state.model {
        return Err("STARTUP_MODEL_HOLD: native launch model changed; no goal created".to_owned());
    }
    if !state.settled || state.goal.status != GoalStatus::None || objective.is_none_or(is_blank) {
        return Err("a fresh settled OMP lane is required to create a goal".to_owned());
    }
    Ok(readback)
}

/// `goal {op:"create"}` must answer with an active goal.
pub(super) fn goal_acknowledged(data: Option<&Value>) -> Result<(), &'static str> {
    let status = data
        .and_then(|data| data.get("goal"))
        .filter(|goal| goal.is_object())
        .and_then(|goal| goal.get("status"));
    if status.and_then(Value::as_str) == Some("active") {
        Ok(())
    } else {
        Err("OMP did not acknowledge an active goal")
    }
}

/// `HeadlessBeginOutcome`: the observation followed by `modelReadback`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BeginOutcome {
    #[serde(flatten)]
    pub(super) observation: Observation,
    pub(super) model_readback: ModelReadback,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::headless::events::Events;
    use crate::headless::protocol::{Snapshot, native_state_of, snapshot};

    const REF_ID: &str = "00000000-0000-4000-8000-000000000001";
    const SESSION: &str = "fixture-session";
    const STARTED_AT: &str = "2026-11-21T00:00:00.000Z";

    fn binding(model: &str) -> LaunchBinding<'_> {
        LaunchBinding {
            ref_id: REF_ID,
            session_id: SESSION,
            model,
            started_at: STARTED_AT,
        }
    }

    /// test/fixtures/headless-rpc.ts `get_entries` with its `CATALY_TEST_MODEL_ATTESTATION` scenarios.
    fn entries(requested: &str, scenario: &str, thinking: Option<Value>) -> Value {
        let (provider, id) = requested.split_once('/').unwrap();
        let observed = if scenario == "mismatch" {
            json!({ "provider": "other", "id": "initial" })
        } else {
            json!({ "provider": "fixture", "id": "initial" })
        };
        let mut proof = json!({
            "requested": { "provider": provider, "id": id },
            "observed": observed,
            "status": if matches!(scenario, "mismatch" | "unavailable" | "unknown") { scenario } else { "matched" },
            "billing": "non-subscription",
            "checkedAt": if scenario == "stale" { "2000-01-01T00:00:00.000Z" } else { "2026-11-21T00:00:02.000Z" },
            "source": "native-extension",
        });
        if let Some(thinking) = thinking {
            proof["thinking"] = thinking;
        }
        let launch = json!({
            "type": "custom",
            "customType": HEADLESS_LAUNCH_MODEL_ENTRY,
            "data": {
                "refId": if scenario == "foreign" { "different-host" } else { REF_ID },
                "sessionId": if scenario == "foreign-session" { "other-session" } else { SESSION },
                "proof": proof,
            },
        });
        let mut list =
            vec![json!({ "type": "custom", "customType": "omp-cataly:role", "data": "lane" })];
        if scenario != "missing" {
            list.push(launch);
        }
        json!({ "entries": list })
    }

    /// `get_state` after `get_entries`; the "changed" scenario switches the model's case.
    fn state(scenario: &str) -> NativeState {
        let id = if scenario == "changed" {
            "Initial"
        } else {
            "initial"
        };
        native_state_of(Some(&json!({
            "sessionId": SESSION, "sessionFile": "/fixture/session.jsonl", "isSettled": true, "goal": null,
            "model": { "provider": if scenario == "mismatch" { "other" } else { "fixture" }, "id": id },
        })))
        .unwrap()
    }

    fn begin(
        model: &str,
        scenario: &str,
        thinking: Option<Value>,
    ) -> Result<ModelReadback, String> {
        let readback =
            read_launch_model(Some(&entries(model, scenario, thinking)), &binding(model));
        begin_verdict(readback, &state(scenario), Some("objective"))
    }

    #[test]
    fn the_last_launch_model_flag_binds_the_model() {
        let argv = |args: &[&str]| args.iter().map(|&arg| arg.to_owned()).collect::<Vec<_>>();
        assert_eq!(
            launch_model_from_argv(&argv(&["omp", "--model", "x/y"])),
            None
        );
        assert_eq!(
            launch_model_from_argv(&argv(&[
                "--cataly-launch-model=a/b",
                "--cataly-launch-model=c/d"
            ])),
            Some("c/d")
        );
        assert_eq!(
            launch_model_from_argv(&argv(&["--cataly-launch-model="])),
            Some("")
        );
        assert_eq!(
            launch_model_from_argv(&argv(&["--cataly-launch-model"])),
            None
        );
    }

    // test/runtime-headless-launch-model.test.ts "a live host without a bound launch model cannot create a goal".
    #[test]
    fn begin_needs_a_session_and_a_bound_launch_model() {
        let unbound = Err("STARTUP_MODEL_HOLD: no launch model bound; no goal created");
        assert_eq!(begin_preflight(Some(SESSION), None), unbound);
        assert_eq!(begin_preflight(Some(SESSION), Some("")), unbound);
        let anonymous = Err("native goal creation requires an exact session identity");
        assert_eq!(begin_preflight(None, None), anonymous);
        assert_eq!(
            begin_preflight(Some(""), Some("fixture/initial")),
            anonymous
        );
        assert_eq!(
            begin_preflight(Some(SESSION), Some("fixture/initial")),
            Ok(())
        );
    }

    // test/runtime-headless-launch-model.test.ts "native goal is never created with <scenario> model attestation".
    #[test]
    fn every_unproven_attestation_holds_the_goal() {
        for (scenario, detail) in [
            ("mismatch", "mismatch"),
            ("unavailable", "unavailable"),
            ("unknown", "unknown"),
            ("missing", "unconfirmed"),
            ("foreign", "unconfirmed"),
            ("foreign-session", "unconfirmed"),
            ("stale", "unconfirmed"),
            ("changed", "changed"),
        ] {
            assert_eq!(
                begin("fixture/initial", scenario, None),
                Err(format!(
                    "STARTUP_MODEL_HOLD: native launch model {detail}; no goal created"
                )),
                "{scenario}"
            );
        }
    }

    // "required readback accepts the native canonical identity and records it separately from the request".
    #[test]
    fn a_matched_readback_records_request_and_native_identity() {
        let readback = begin("Fixture/INITIAL", "matched", None).unwrap();
        assert_eq!(
            serde_json::to_string(&readback).unwrap(),
            concat!(
                r#"{"requested":{"provider":"Fixture","id":"INITIAL"},"observed":{"provider":"fixture","id":"initial"},"#,
                r#""checkedAt":"2026-11-21T00:00:02.000Z","status":"matched","billing":"non-subscription","#,
                r#""source":"native-extension"}"#
            )
        );
    }

    // "a thinking-suffixed launch creates the goal once the base model and native level read back".
    #[test]
    fn a_thinking_suffix_matches_the_base_model_and_level() {
        let readback = begin(
            "fixture/initial:high",
            "matched",
            Some(json!({ "requested": "high", "observed": "high" })),
        );
        let shown = serde_json::to_string(&readback.unwrap()).unwrap();
        assert!(shown.starts_with(r#"{"requested":{"provider":"fixture","id":"initial:high"},"observed":{"provider":"fixture","id":"initial"}"#), "{shown}");
        assert!(
            shown.ends_with(
                r#""source":"native-extension","thinking":{"requested":"high","observed":"high"}}"#
            ),
            "{shown}"
        );
    }

    // "<model> with thinking <record> never creates a native goal".
    #[test]
    fn inconsistent_thinking_records_never_match() {
        let unconfirmed =
            Err("STARTUP_MODEL_HOLD: native launch model unconfirmed; no goal created".to_owned());
        for (model, thinking) in [
            ("fixture/initial:high", json!({})),
            (
                "fixture/initial:high",
                json!({ "requested": "high", "observed": "low" }),
            ),
            (
                "fixture/initial:14b",
                json!({ "requested": "14b", "observed": "14b" }),
            ),
            ("fixture/initial:high", Value::Null),
            (
                "fixture/initial:HIGH",
                json!({ "requested": "HIGH", "observed": "HIGH" }),
            ),
        ] {
            assert_eq!(
                begin(model, "matched", Some(thinking.clone())),
                unconfirmed,
                "{model} {thinking}"
            );
        }
        // Without a thinking record the literal colon id must itself be observed.
        assert_eq!(begin("fixture/initial:high", "matched", None), unconfirmed);
    }

    #[test]
    fn the_proof_must_be_bound_to_this_launch() {
        let model = "fixture/initial";
        let good = entries(model, "matched", None);
        assert!(read_launch_model(Some(&good), &binding(model)).is_some());
        let mutate = |edit: &dyn Fn(&mut Value)| {
            let mut data = good.clone();
            edit(&mut data["entries"][1]["data"]);
            read_launch_model(Some(&data), &binding(model))
        };
        assert!(mutate(&|data| data["proof"]["checkedAt"] = json!(STARTED_AT)).is_some());
        assert!(
            mutate(&|data| data["proof"]["checkedAt"] = json!("2026-11-20T23:59:59.999Z"))
                .is_none()
        );
        assert!(mutate(&|data| data["proof"]["checkedAt"] = json!("not a date")).is_none());
        assert!(mutate(&|data| data["proof"]["checkedAt"] = json!("")).is_none());
        assert!(mutate(&|data| data["proof"]["source"] = json!("launch-preflight")).is_none());
        assert!(mutate(&|data| data["proof"]["billing"] = json!("free")).is_none());
        assert!(mutate(&|data| data["proof"]["status"] = json!("unrequested")).is_none());
        assert!(
            mutate(&|data| data["proof"]["requested"] =
                json!({ "provider": "fixture", "id": "other" }))
            .is_none()
        );
        assert!(
            mutate(
                &|data| data["proof"]["observed"] = json!({ "provider": "fixture", "id": "other" })
            )
            .is_none()
        );
        assert!(mutate(&|data| data["proof"]["observed"] = Value::Null).is_none());
        assert!(mutate(&|data| data["refId"] = json!(1)).is_none());
        assert!(mutate(&|data| data["proof"] = json!("proof")).is_none());
        let unknown = mutate(&|data| {
            data["proof"]["status"] = json!("unknown");
            data["proof"]["observed"] = Value::Null;
        });
        assert_eq!(
            unknown.map(|readback| (readback.status, readback.observed)),
            Some((ReadbackStatus::Unknown, None))
        );
        // An unparseable request never matches, whatever the extension claims.
        assert!(
            read_launch_model(
                Some(&entries("bad model/x", "matched", None)),
                &binding("bad model/x")
            )
            .is_none()
        );
    }

    #[test]
    fn only_a_fresh_settled_lane_with_an_objective_gets_a_goal() {
        let fresh = "a fresh settled OMP lane is required to create a goal".to_owned();
        let readback = || {
            read_launch_model(
                Some(&entries("fixture/initial", "matched", None)),
                &binding("fixture/initial"),
            )
        };
        let mut busy = state("matched");
        busy.settled = false;
        assert_eq!(
            begin_verdict(readback(), &busy, Some("o")),
            Err(fresh.clone())
        );
        let mut active = state("matched");
        active.goal.status = GoalStatus::Active;
        assert_eq!(
            begin_verdict(readback(), &active, Some("o")),
            Err(fresh.clone())
        );
        assert_eq!(
            begin_verdict(readback(), &state("matched"), Some(" \u{feff}")),
            Err(fresh.clone())
        );
        assert_eq!(
            begin_verdict(readback(), &state("matched"), None),
            Err(fresh)
        );
        let mut unmodelled = state("matched");
        unmodelled.model = None;
        assert_eq!(
            begin_verdict(readback(), &unmodelled, Some("o")),
            Err("STARTUP_MODEL_HOLD: native launch model changed; no goal created".to_owned())
        );
        assert!(begin_verdict(readback(), &state("matched"), Some("o")).is_ok());
    }

    #[test]
    fn goal_creation_must_answer_with_an_active_goal() {
        assert_eq!(
            goal_acknowledged(Some(
                &json!({ "goal": { "status": "active", "objective": "o" } })
            )),
            Ok(())
        );
        let refused = Err("OMP did not acknowledge an active goal");
        assert_eq!(
            goal_acknowledged(Some(&json!({ "goal": { "status": "paused" } }))),
            refused
        );
        assert_eq!(goal_acknowledged(Some(&json!({ "goal": null }))), refused);
        assert_eq!(
            goal_acknowledged(Some(&json!({ "status": "active" }))),
            refused
        );
        assert_eq!(goal_acknowledged(None), refused);
    }

    #[test]
    fn the_begin_reply_appends_model_readback_to_the_observation() {
        let events = Events::default();
        let reference = serde_json::from_str(r#"{"runtime":"headless","id":"x"}"#).unwrap();
        let observation = snapshot(&Snapshot {
            reference: Some(&reference),
            cwd: None,
            started_at: None,
            pid: None,
            harness_role: None,
            bound: None,
            state: None,
            latest: None,
            fault: false,
            stopping: false,
            detail: None,
            events: &events,
        });
        let model_readback = begin("fixture/initial", "matched", None).unwrap();
        let shown = serde_json::to_string(&BeginOutcome {
            observation,
            model_readback,
        })
        .unwrap();
        assert!(
            shown.starts_with(r#"{"ref":{"runtime":"headless","id":"x"},"updatedAt":"#),
            "{shown}"
        );
        assert!(
            shown.contains(r#""dialogs":[],"recent":[],"modelReadback":{"requested":"#),
            "{shown}"
        );
    }

    #[test]
    fn exact_identities_follow_the_lane_state_grammar() {
        let identity = |value: &str| exact_model_identity(value).map(|m| (m.provider, m.id));
        assert_eq!(
            identity("Fixture/INITIAL"),
            Some(("Fixture".to_owned(), "INITIAL".to_owned()))
        );
        assert_eq!(
            identity("a.b_c-d/e/f:g"),
            Some(("a.b_c-d".to_owned(), "e/f:g".to_owned()))
        );
        for bad in [
            "-a/b",
            "a/",
            "/b",
            "ab",
            "a b/c",
            "a/b c",
            "a/b*",
            "a/b,c",
            "a/b\u{feff}",
            "é/b",
        ] {
            assert_eq!(identity(bad), None, "{bad}");
        }
        assert!(identity("a/b\u{85}").is_some());
    }
}

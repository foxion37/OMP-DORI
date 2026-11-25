//! `Broker` (`src/runtime/headless-broker.ts`): one OMP `rpc-ui` child for the roles `lane`, `lead` and `duty`, its
//! proven identity, dialogs and answers, local delivery, goal changes, close receipts and the remote commands.
//!
//! `observe` never queues behind a dialog or the handshake; every mutation goes through `check` (bound identity, no
//! dialog, no fault, not stopping, fresh readback) and `exclusive` (one in-flight mutation).

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use serde::Serialize;
use serde_json::Value;

use super::events::Events;
use super::http::Reply;
use super::launch_model::{
    BeginOutcome, LaunchBinding, begin_preflight, begin_verdict, goal_acknowledged,
    launch_model_from_argv, read_launch_model,
};
use super::protocol::{
    AgentStatus, CatalyRole, Expected, GoalStatus, GoalTarget, HarnessRole, NativeState,
    Observation, Request, Snapshot, answer_frame, harness_role, last_custom_data, native_state_of,
    parse_cataly_role, parse_request, snapshot,
};
use super::record::HostStart;
use super::remote::{self, Remote};
use super::rpc::{self, Launch, Rpc};
use crate::json::Json;

/// An operation's result; the error is the message the envelope carries.
pub(super) type Op<T> = Result<T, String>;

const HOLD: &str = "native identity or actionable dialog holds this operation";
const DISCONNECTED: &str = "OMP RPC stream disconnected or became untrustworthy";

/// Serializes an operation's value for the `{ok,value}` envelope.
pub(super) fn raw<T: Serialize>(value: &T) -> Reply {
    serde_json::value::to_raw_value(value)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// An RPC command `{type, ...fields}` in TypeScript key order.
pub(super) fn command(kind: &str, fields: Vec<(&str, Json)>) -> Json {
    let mut all = vec![("type", Json::string(kind))];
    all.extend(fields);
    Json::object(all)
}

#[derive(Default)]
struct State {
    events: Events,
    /// `this.bound`: the identity `proveNativeRole` established.
    bound: Option<NativeState>,
    /// `this.state`: the last successful readback.
    latest: Option<NativeState>,
    expected_model: Option<String>,
    detail: Option<String>,
    mutation: bool,
    stopping: bool,
    fault: bool,
    closed_session_id: Option<String>,
    /// Completed `get_state` readbacks, so a caller that waited on one in flight shares its result
    /// (`this.stateRead ??= ...`).
    refreshes: u64,
    refreshed: Option<Op<Option<NativeState>>>,
}

fn guard(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

const fn role_name(role: HarnessRole) -> &'static str {
    match role {
        HarnessRole::Lead => "lead",
        HarnessRole::Duty => "duty",
    }
}

pub struct Broker {
    reservation: Json,
    harness_role: Option<HarnessRole>,
    state: Arc<Mutex<State>>,
    rpc: OnceLock<Rpc>,
    refresh: tokio::sync::Mutex<()>,
    remote: Remote,
    /// Set once `stopped.json` has been written (or its write failed). In Bun that write runs synchronously on
    /// `rpc.exited` before an awaiting `close` continuation can reply; replies that waited on OMP's exit wait here.
    receipt: tokio::sync::watch::Sender<bool>,
}

impl Broker {
    pub(crate) fn new(reservation: Json) -> Self {
        Self {
            harness_role: reservation.str("role").and_then(harness_role),
            reservation,
            state: Arc::default(),
            rpc: OnceLock::new(),
            refresh: tokio::sync::Mutex::new(()),
            remote: Remote::default(),
            receipt: tokio::sync::watch::Sender::new(false),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        guard(&self.state)
    }

    fn ref_id(&self) -> &str {
        self.reservation
            .get("ref")
            .and_then(|reference| reference.str("id"))
            .unwrap_or_default()
    }

    /// The session ID the last successful `close`/`remote-close` disconnected.
    pub(crate) fn closed_session_id(&self) -> Option<String> {
        self.state().closed_session_id.clone()
    }

    /// Marks the stop receipt attempted, releasing the `close`/`remote-close` replies waiting on it.
    pub(crate) fn receipt_published(&self) {
        self.receipt.send_replace(true);
    }

    /// `start`: spawns OMP, proves its role and identity, and returns its exit code once it exits.
    pub(crate) async fn start(&self, start: &HostStart, overlay: &Path) -> anyhow::Result<i32> {
        let (argv, env) = start.strings()?;
        self.state().expected_model = launch_model_from_argv(&argv).map(str::to_owned);
        let cwd = self
            .reservation
            .str("cwd")
            .ok_or_else(|| anyhow::anyhow!("headless reservation cwd is not a path"))?;
        let events = Arc::clone(&self.state);
        let faults = Arc::clone(&self.state);
        let rpc = rpc::start(
            &Launch {
                argv: &argv,
                env: &env,
                cwd,
                id: self.ref_id(),
            },
            overlay,
            Box::new(move |frame| guard(&events).events.record(frame)),
            Box::new(move || {
                let mut state = guard(&faults);
                state.fault = true;
                if !state.stopping {
                    state.detail = Some(DISCONNECTED.to_owned());
                }
            }),
        )
        .await?;
        let rpc = self.rpc.get_or_init(|| rpc);
        match self.prove(rpc, start.expected_resume_id.as_ref()).await {
            Ok(bound) => {
                self.state().bound = Some(bound);
                Ok(rpc.exited().await)
            }
            Err(error) => {
                let graceful = {
                    let mut state = self.state();
                    state.detail = Some(error.clone());
                    !state.events.has_dialogs()
                        && state.latest.as_ref().is_some_and(|latest| latest.settled)
                        && !state.fault
                };
                // A stalled native exit is still live; do not publish a stopped receipt while it owns the session.
                if !graceful || rpc.shutdown().await.is_err() {
                    rpc.exited().await;
                }
                Err(anyhow::anyhow!(error))
            }
        }
    }

    /// `proveNativeRole`: a stable persisted session that carries this host's Cataly role.
    async fn prove(&self, rpc: &Rpc, expected: Option<&Value>) -> Op<NativeState> {
        rpc.wait_ready().await.map_err(|error| error.to_string())?;
        rpc.request(command(
            "set_ask_dialog",
            vec![("enabled", Json::Bool(true))],
        ))
        .await
        .map_err(|error| error.to_string())?;
        let before = self.refresh().await?;
        let entries = rpc
            .request(command("get_entries", Vec::new()))
            .await
            .map_err(|error| error.to_string())?;
        let role = parse_cataly_role(last_custom_data(entries.as_ref(), "omp-cataly:role"));
        let proof = last_custom_data(entries.as_ref(), "omp-cataly:harness-role")
            .filter(|proof| proof.is_object());
        let current = self.refresh().await?;
        let harness = self.harness_role;
        let proven_role = harness.map_or_else(
            || role == Some(CatalyRole::Lane),
            |harness| {
                role == Some(CatalyRole::Cataly)
                    && proof.is_some_and(|proof| {
                        proof.get("role").and_then(Value::as_str) == Some(role_name(harness))
                            && proof.get("refId").and_then(Value::as_str) == Some(self.ref_id())
                    })
            },
        );
        let stable = match (&before, &current) {
            (Some(before), Some(current)) => {
                before.session_id == current.session_id
                    && before.session_file == current.session_file
                    && (harness.is_none() || Path::new(&current.session_file).is_file())
                    && expected.is_none_or(|expected| {
                        expected.as_str() == Some(current.session_id.as_str())
                    })
            }
            _ => false,
        };
        match current {
            Some(current) if proven_role && stable => Ok(current),
            _ => Err(format!(
                "OMP did not prove a stable persisted session with the Cataly {} role",
                harness.map_or("lane", role_name)
            )),
        }
    }

    /// `refresh`: one `get_state` readback at a time; callers that arrive while one is in flight share it.
    async fn refresh(&self) -> Op<Option<NativeState>> {
        let Some(rpc) = self.rpc.get() else {
            return Ok(None);
        };
        let seen = {
            let state = self.state();
            if state.fault || state.stopping {
                return Ok(None);
            }
            state.refreshes
        };
        let _turn = self.refresh.lock().await;
        {
            let state = self.state();
            if state.refreshes != seen
                && let Some(shared) = &state.refreshed
            {
                return shared.clone();
            }
        }
        let result = match rpc.request(command("get_state", Vec::new())).await {
            Err(error) => Err(error.to_string()),
            Ok(data) => {
                Ok(native_state_of(data.as_ref()).and_then(|readback| self.accept(readback)))
            }
        };
        let mut state = self.state();
        state.refreshes += 1;
        state.refreshed = Some(result.clone());
        drop(state);
        result
    }

    /// Records a readback unless OMP switched transcripts under the bound identity.
    fn accept(&self, readback: NativeState) -> Option<NativeState> {
        let mut state = self.state();
        if state.bound.as_ref().is_some_and(|bound| {
            bound.session_id != readback.session_id || bound.session_file != readback.session_file
        }) {
            state.fault = true;
            state.detail = Some("OMP changed its bound transcript".to_owned());
            return None;
        }
        if readback.settled {
            state.events.settle();
        }
        state.latest = Some(readback.clone());
        drop(state);
        Some(readback)
    }

    fn snapshot(&self, readback: Option<&NativeState>) -> Observation {
        let state = self.state();
        snapshot(&Snapshot {
            reference: self.reservation.get("ref"),
            cwd: self.reservation.get("cwd"),
            started_at: self.reservation.get("startedAt"),
            pid: self.rpc.get().map(Rpc::pid),
            harness_role: self.harness_role,
            bound: state.bound.as_ref(),
            state: readback,
            latest: state.latest.as_ref(),
            fault: state.fault,
            stopping: state.stopping,
            detail: state.detail.as_deref(),
            events: &state.events,
        })
    }

    /// `observe`: reading during a dialog or the initial handshake does not queue behind it.
    async fn observe(&self) -> Observation {
        let held = {
            let state = self.state();
            (state.bound.is_none() || state.events.has_dialogs() || state.stopping)
                .then(|| state.latest.clone().filter(|_| state.events.has_dialogs()))
        };
        if let Some(readback) = held {
            return self.snapshot(readback.as_ref());
        }
        let readback = self.refresh().await.ok().flatten();
        self.snapshot(readback.as_ref())
    }

    fn holds(&self, expected: Option<&Expected>) -> bool {
        let state = self.state();
        state.bound.as_ref().is_none_or(|bound| {
            expected.is_some_and(|expected| !expected.admits(&bound.session_id))
        }) || state.events.has_dialogs()
            || state.fault
            || state.stopping
    }

    /// `check`: the bound identity with no actionable dialog, and a fresh readback.
    pub(super) async fn check(&self, expected: &Expected) -> Op<NativeState> {
        if self.holds(Some(expected)) {
            return Err(HOLD.to_owned());
        }
        let readback = self.refresh().await?;
        match readback {
            Some(readback) if !self.holds(None) => Ok(readback),
            _ => Err(HOLD.to_owned()),
        }
    }

    pub(super) fn has_dialogs(&self) -> bool {
        self.state().events.has_dialogs()
    }

    /// The bound session remote commands must name (`undefined` once faulted).
    pub(super) fn remote_session(&self) -> Option<String> {
        let state = self.state();
        state
            .bound
            .as_ref()
            .filter(|_| !state.fault)
            .map(|bound| bound.session_id.clone())
    }

    /// `exclusive`: refuses a second mutation while one is in flight.
    pub(super) async fn exclusive<T>(&self, operation: impl Future<Output = Op<T>>) -> Op<T> {
        struct Release<'a>(&'a Mutex<State>);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                guard(self.0).mutation = false;
            }
        }
        {
            let mut state = self.state();
            if state.mutation {
                return Err("another headless operation is in flight".to_owned());
            }
            state.mutation = true;
        }
        let _release = Release(&self.state);
        operation.await
    }

    /// `shutdown`: marks the host stopping, records the closed session, and disconnects OMP. Once OMP has exited,
    /// the reply waits for `stopped.json`, so a client that observes right after `close` sees the host gone.
    pub(super) async fn shutdown(&self, rpc: &Rpc, session: &str) -> anyhow::Result<()> {
        {
            let mut state = self.state();
            state.stopping = true;
            state.closed_session_id = Some(session.to_owned());
        }
        rpc.shutdown().await?;
        let mut receipt = self.receipt.subscribe();
        // The sender lives in `self`, so this resolves exactly when the receipt is published.
        let _ = receipt.wait_for(|published| *published).await;
        Ok(())
    }

    /// `handle(request)` for a body the endpoint admitted (an object with a string `op`).
    pub(crate) async fn handle(&self, body: Value) -> Reply {
        let Some(request) = parse_request(&body) else {
            return Err("Unsupported headless operation".to_owned());
        };
        if request == Request::Observe {
            return raw(&self.observe().await);
        }
        let Some(rpc) = self.rpc.get() else {
            return Err("OMP process has not started".to_owned());
        };
        match request {
            Request::Remote {
                expected_session_id,
                command,
            } => {
                if self.harness_role.is_some() {
                    return Err("native harness roles use the harness controls".to_owned());
                }
                self.remote
                    .handle(self, rpc, expected_session_id, command)
                    .await
            }
            Request::Answer {
                expected_session_id,
                request_id,
                answer,
            } => {
                self.answer(rpc, expected_session_id, request_id, &answer)
                    .await
            }
            other => self.exclusive(self.mutate(rpc, other)).await,
        }
    }

    async fn answer(
        &self,
        rpc: &Rpc,
        expected_session_id: Option<String>,
        request_id: Option<String>,
        answer: &Value,
    ) -> Reply {
        {
            let state = self.state();
            // Only a proven identity can be answered for, and only when the request names it exactly.
            let matches = state.bound.as_ref().is_some_and(|bound| {
                expected_session_id.as_deref() == Some(bound.session_id.as_str())
            });
            if state.fault || state.stopping || !matches {
                return Err("native dialog session does not match".to_owned());
            }
        }
        let readback = self.refresh().await.ok().flatten();
        let frame = {
            let mut state = self.state();
            if readback.is_none() || state.fault || state.stopping {
                return Err("native dialog session readback unconfirmed".to_owned());
            }
            let frame = request_id.as_deref().and_then(|id| {
                let dialog = state.events.dialog(id)?;
                answer_frame(dialog, answer).map(|frame| (id, frame))
            });
            let Some((id, frame)) = frame else {
                return Err("no matching native dialog or unsupported answer".to_owned());
            };
            // No answer replay after attempting the write; RPC UI replies do not have an ack.
            state.events.remove_dialog(id);
            drop(state);
            serde_json::to_string(&frame).map_err(|error| error.to_string())?
        };
        if rpc.send(&frame).await.is_err() {
            self.state().fault = true;
            return Err("native answer delivery ambiguous; do not resend".to_owned());
        }
        raw(&Submitted { submitted: true })
    }

    /// The operations `exclusive` serializes: deliver, begin, goal and close.
    async fn mutate(&self, rpc: &Rpc, request: Request) -> Reply {
        match request {
            Request::Deliver { text, options } => {
                let options = options.map_err(str::to_owned)?;
                match self.check(&options.expected_session_id).await {
                    Ok(state) => raw(&remote::deliver_local(rpc, &state, text, &options).await?),
                    Err(_) => raw(&remote::DeliverOutcome::NotReady {
                        status: if self.has_dialogs() {
                            AgentStatus::Blocked
                        } else {
                            AgentStatus::Unknown
                        },
                    }),
                }
            }
            Request::Begin {
                expected_session_id,
                objective,
            } => self.begin(rpc, expected_session_id, objective).await,
            Request::Goal {
                expected_session_id,
                target,
            } => self.goal(rpc, &expected_session_id, target).await,
            Request::Close {
                expected_session_id,
            } => {
                let state = self.check(&expected_session_id).await?;
                if !state.settled {
                    return Err("only a settled OMP session can close".to_owned());
                }
                self.shutdown(rpc, &state.session_id)
                    .await
                    .map_err(|error| error.to_string())?;
                raw(&Closed { closed: true })
            }
            Request::Observe
            | Request::Answer { .. }
            | Request::Remote { .. }
            | Request::Unsupported => Err("Unsupported headless operation".to_owned()),
        }
    }

    /// `beginNativeGoal`: a goal only for a fresh settled lane whose launch model the extension proved.
    async fn begin(
        &self,
        rpc: &Rpc,
        expected_session_id: Option<String>,
        objective: Option<String>,
    ) -> Reply {
        if self.harness_role.is_some() {
            return Err("harness role cannot start a lane goal".to_owned());
        }
        let model = self.state().expected_model.clone();
        begin_preflight(expected_session_id.as_deref(), model.as_deref()).map_err(str::to_owned)?;
        let (Some(session), Some(model)) = (expected_session_id, model) else {
            return Err("native goal creation requires an exact session identity".to_owned());
        };
        // get_available_models applies enabledModels; the extension sees the full provider catalog.
        let entries = rpc
            .request(command("get_entries", Vec::new()))
            .await
            .map_err(|error| error.to_string())?;
        let readback = read_launch_model(
            entries.as_ref(),
            &LaunchBinding {
                ref_id: self.ref_id(),
                session_id: &session,
                model: &model,
                started_at: self.reservation.str("startedAt").unwrap_or_default(),
            },
        );
        let state = self.check(&Expected::Session(session)).await?;
        let model_readback = begin_verdict(readback, &state, objective.as_deref())?;
        let objective = objective.unwrap_or_default();
        let created = rpc
            .request(command(
                "goal",
                vec![
                    ("op", Json::string("create")),
                    ("objective", Json::String(objective)),
                ],
            ))
            .await
            .map_err(|error| error.to_string())?;
        goal_acknowledged(created.as_ref()).map_err(str::to_owned)?;
        raw(&BeginOutcome {
            observation: self.observe().await,
            model_readback,
        })
    }

    /// `setNativeGoal`: pause or resume a live goal; pausing an unsettled turn also aborts it.
    async fn goal(&self, rpc: &Rpc, expected: &Expected, target: GoalTarget) -> Reply {
        if self.harness_role.is_some() {
            return Err("harness role cannot change a lane goal".to_owned());
        }
        let status = self.check(expected).await?.goal.status;
        if status == GoalStatus::Blocked {
            return Err("native goal requires direct inspection".to_owned());
        }
        let terminal = matches!(
            status,
            GoalStatus::None | GoalStatus::Complete | GoalStatus::Dropped
        );
        if !terminal && !target.reached(status) {
            rpc.request(command("goal", vec![("op", Json::string(target.op()))]))
                .await
                .map_err(|error| error.to_string())?;
        }
        let after = self.check(expected).await?;
        if !terminal && !target.reached(after.goal.status) {
            return Err("native goal change was not confirmed".to_owned());
        }
        if target == GoalTarget::Paused && !after.settled {
            rpc.request(command("abort", Vec::new()))
                .await
                .map_err(|error| error.to_string())?;
            if !self.check(expected).await?.settled {
                return Err("native turn interruption was not confirmed".to_owned());
            }
        }
        raw(&self.observe().await)
    }
}

#[derive(Serialize)]
struct Submitted {
    submitted: bool,
}

#[derive(Serialize)]
struct Closed {
    closed: bool,
}

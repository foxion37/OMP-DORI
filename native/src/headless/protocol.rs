//! Broker side of `src/runtime/headless-protocol.ts`: the socket request union, the observation wire types, and the
//! pure parsers over OMP `rpc-ui` frames (`entryOf`, `dialogOf`, `answerFrame`, `goalOf`, `modelOf`), plus
//! `nativeStateOf` (`headless-rpc.ts`), `Broker.snapshot` (`headless-broker.ts`) and the `session-compat.ts` aliases.
//!
//! Every check mirrors the TypeScript, including its loose field semantics, so the Rust host and the Bun host give the
//! same answer and the same error text for the same request.

use serde::Serialize;
use serde_json::{Map, Value};

use super::events::Events;
use crate::json::Json;
use crate::util;

/// `String.prototype.trim` and regex `\s` whitespace: Unicode `White_Space` without U+0085, plus U+FEFF.
pub(super) const fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `!text.trim()`.
pub(super) fn is_blank(text: &str) -> bool {
    text.chars().all(is_js_space)
}

/// `text.trimStart()`.
pub(super) fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// JavaScript truthiness; `None` is `undefined`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Buffer.byteLength(text)` is UTF-8 bytes; `.length` is UTF-16 code units.
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum GoalStatus {
    None,
    Active,
    Paused,
    Complete,
    Dropped,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Goal {
    pub(super) status: GoalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) objective: Option<String>,
}

/// `goalOf`: `Some(&Value::Null)` is OMP's "no goal"; an absent value (`undefined`) is unreadable.
pub(super) fn goal_of(value: Option<&Value>) -> Option<Goal> {
    if value.is_some_and(Value::is_null) {
        return Some(Goal {
            status: GoalStatus::None,
            objective: None,
        });
    }
    let goal = object(object(value)?.get("goal"))?;
    let status = match string(goal.get("status"))? {
        "active" => GoalStatus::Active,
        "paused" => GoalStatus::Paused,
        "complete" => GoalStatus::Complete,
        "dropped" => GoalStatus::Dropped,
        "budget-limited" => GoalStatus::Blocked,
        _ => return None,
    };
    let objective = string(goal.get("objective")).map(str::to_owned);
    Some(Goal { status, objective })
}

/// `modelOf`: `provider/id` from OMP's model object; a provider containing `/` is ambiguous and unreadable.
pub(super) fn model_of(value: Option<&Value>) -> Option<String> {
    let model = object(value)?;
    let provider = string(model.get("provider"))?;
    let id = string(model.get("id"))?;
    (!provider.is_empty() && !provider.contains('/') && !id.is_empty())
        .then(|| format!("{provider}/{id}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum CatalyRole {
    Cataly,
    Lane,
}

/// `parseCatalyRole`.
pub(super) fn parse_cataly_role(value: Option<&Value>) -> Option<CatalyRole> {
    match string(value)? {
        "cataly" => Some(CatalyRole::Cataly),
        "lane" => Some(CatalyRole::Lane),
        _ => None,
    }
}

/// `isCatalyEntry`: exactly `current`.
fn is_cataly_entry(value: Option<&Value>, current: &str) -> bool {
    string(value) == Some(current)
}

/// The `data` of the last `custom` entry named `name` in a `get_entries` reply's data (`findLast(...)?.data`).
pub(super) fn last_custom_data<'a>(entries: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    object(entries)?
        .get("entries")?
        .as_array()?
        .iter()
        .rev()
        .find(|entry| {
            string(entry.get("type")) == Some("custom")
                && is_cataly_entry(entry.get("customType"), name)
        })?
        .get("data")
}

/// `NativeState` (`headless-remote.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct NativeState {
    pub(super) session_id: String,
    pub(super) session_file: String,
    pub(super) goal: Goal,
    pub(super) settled: bool,
    pub(super) foreground: bool,
    pub(super) model: Option<String>,
}

/// `nativeStateOf` over a `get_state` reply's data.
pub(super) fn native_state_of(data: Option<&Value>) -> Option<NativeState> {
    let data = object(data)?;
    let session_id = string(data.get("sessionId")).filter(|id| !id.is_empty())?;
    let session_file = string(data.get("sessionFile")).filter(|file| !file.is_empty())?;
    let goal = goal_of(data.get("goal"))?;
    let settled = data.get("isSettled")?.as_bool()?;
    let flag = |key: &str| data.get(key) == Some(&Value::Bool(true));
    Some(NativeState {
        session_id: session_id.to_owned(),
        session_file: session_file.to_owned(),
        goal,
        settled,
        foreground: flag("isStreaming") || flag("isCompacting"),
        model: model_of(data.get("model")),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Question {
    id: String,
    #[serde(rename = "question")]
    text: String,
    options: Vec<String>,
    multi: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DialogKind {
    Approval,
    Confirm,
    Select,
    Input,
    Editor,
    Ask,
    Unsupported,
}

/// `HeadlessDialog`; field order is `dialogOf`'s emission order, and no kind carries both `options` and `secret`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Dialog {
    pub(super) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    pub(super) kind: DialogKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    questions: Option<Vec<Question>>,
}

impl Dialog {
    const fn bare(id: String, kind: DialogKind) -> Self {
        Self {
            id,
            title: None,
            message: None,
            kind,
            options: None,
            secret: false,
            questions: None,
        }
    }
}

fn question_of(item: &Value) -> Option<Question> {
    let question = item.as_object()?;
    let id = string(question.get("id")).filter(|id| !id.is_empty())?;
    let text = string(question.get("question"))?;
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| string(choice.get("label")).map(str::to_owned))
        .collect();
    Some(Question {
        id: id.to_owned(),
        text: text.to_owned(),
        options,
        multi: question.get("multi") == Some(&Value::Bool(true)),
    })
}

/// `dialogOf` over an `extension_ui_request` frame. Unknown methods (including `open_url`) are `unsupported`: they may
/// be gated, but their content is not exposed and they cannot be answered.
pub(super) fn dialog_of(frame: &Value) -> Option<Dialog> {
    let id = string(frame.get("id"))
        .filter(|id| !id.is_empty())?
        .to_owned();
    let summary = |kind| Dialog {
        title: string(frame.get("title")).map(str::to_owned),
        message: string(frame.get("message")).map(str::to_owned),
        ..Dialog::bare(id.clone(), kind)
    };
    match string(frame.get("method")) {
        Some("select") => {
            let options: Vec<String> = frame
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| option.as_str().map(str::to_owned))
                .collect();
            let has = |label: &str| options.iter().any(|option| option == label);
            // Pinned OMP tools/approval.ts uses this select fallback, including Deny and the single-call approval.
            let approval = has("Deny") && (has("Approve") || has("Approve Once"));
            let kind = if approval {
                DialogKind::Approval
            } else {
                DialogKind::Select
            };
            Some(Dialog {
                options: Some(options),
                ..summary(kind)
            })
        }
        Some("confirm") => Some(summary(DialogKind::Confirm)),
        Some("input") => Some(Dialog {
            secret: frame.get("secret") == Some(&Value::Bool(true)),
            ..summary(DialogKind::Input)
        }),
        Some("editor") => Some(summary(DialogKind::Editor)),
        Some("ask") => {
            let questions: Vec<Question> = frame
                .get("questions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(question_of)
                .collect();
            Some(if questions.is_empty() {
                Dialog::bare(id, DialogKind::Unsupported)
            } else {
                Dialog {
                    questions: Some(questions),
                    ..Dialog::bare(id, DialogKind::Ask)
                }
            })
        }
        Some("cancel" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text") => {
            None
        }
        _ => Some(Dialog::bare(id, DialogKind::Unsupported)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum EntryKind {
    Assistant,
    Output,
    Notice,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Entry {
    kind: EntryKind,
    text: String,
}

const ENTRY_UNITS: usize = 2_000;

/// `text.slice(-limit)` in UTF-16 code units. JavaScript can keep the low half of a split surrogate pair; a Rust string
/// cannot hold it, so that orphan unit is dropped.
fn last_units(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices().rev() {
        units += c.len_utf16();
        if units > limit {
            return &text[at + c.len_utf8()..];
        }
    }
    text
}

/// `entryOf`: the read-only output ring's view of an assistant message, command output or notice.
pub(super) fn entry_of(frame: &Value) -> Option<Entry> {
    let message = object(frame.get("message"));
    let kind_of = string(frame.get("type"));
    let (kind, text) = if kind_of == Some("message_end")
        && message.is_some_and(|m| string(m.get("role")) == Some("assistant"))
        && let Some(content) = message
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
    {
        let text: String = content
            .iter()
            .filter(|part| string(part.get("type")) == Some("text"))
            .filter_map(|part| string(part.get("text")))
            .collect();
        (EntryKind::Assistant, Some(text))
    } else if kind_of == Some("command_output") {
        (
            EntryKind::Output,
            string(frame.get("text")).map(str::to_owned),
        )
    } else if kind_of == Some("extension_ui_request")
        && string(frame.get("method")) == Some("notify")
    {
        (
            EntryKind::Notice,
            string(frame.get("message")).map(str::to_owned),
        )
    } else {
        return None;
    };
    let text = text.filter(|text| !is_blank(text))?;
    let clean: String = text
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect();
    Some(Entry {
        kind,
        text: last_units(&clean, ENTRY_UNITS).to_owned(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnswerItem {
    id: String,
    selected_options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_input: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum AnswerResponse {
    Cancelled(bool),
    Confirmed(bool),
    Value(String),
    Answers(Vec<AnswerItem>),
}

/// The `extension_ui_response` frame `answerFrame` builds; serializes as `{type,id,<one response field>}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct AnswerFrame {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    #[serde(flatten)]
    response: AnswerResponse,
}

fn answer_item(question: &Question, answer: &Value) -> Option<AnswerItem> {
    let answer = answer.as_object()?;
    if string(answer.get("id")) != Some(question.id.as_str()) {
        return None;
    }
    let selected = answer.get("selectedOptions")?.as_array()?;
    let selected: Vec<String> = selected
        .iter()
        .map(|option| {
            option
                .as_str()
                .filter(|option| question.options.iter().any(|known| known == option))
                .map(str::to_owned)
        })
        .collect::<Option<_>>()?;
    if selected
        .iter()
        .enumerate()
        .any(|(at, option)| selected[..at].contains(option))
    {
        return None;
    }
    let custom = match answer.get("customInput") {
        None => None,
        Some(Value::String(custom)) => Some(custom.clone()),
        Some(_) => return None,
    };
    let filled = custom.as_deref().is_some_and(|custom| !is_blank(custom));
    if (!question.multi && selected.len() + usize::from(filled) > 1)
        || (selected.is_empty() && !filled)
    {
        return None;
    }
    Some(AnswerItem {
        id: question.id.clone(),
        selected_options: selected,
        custom_input: custom,
    })
}

/// `answerFrame`: exactly one recognized answer field for the dialog's kind. Unrecognized fields (notably `timedOut`,
/// which may submit recommended answers) are never forwarded, secrets are never answered, and approvals grant one call
/// only: no session or global grants.
pub(super) fn answer_frame(dialog: &Dialog, answer: &Value) -> Option<AnswerFrame> {
    let response = answer.as_object().filter(|response| response.len() == 1)?;
    let frame = |response| {
        Some(AnswerFrame {
            kind: "extension_ui_response",
            id: dialog.id.clone(),
            response,
        })
    };
    if dialog.kind != DialogKind::Unsupported
        && response.get("cancelled") == Some(&Value::Bool(true))
    {
        return frame(AnswerResponse::Cancelled(true));
    }
    if dialog.secret || dialog.kind == DialogKind::Unsupported {
        return None;
    }
    if dialog.kind == DialogKind::Confirm
        && let Some(Value::Bool(confirmed)) = response.get("confirmed")
    {
        return frame(AnswerResponse::Confirmed(*confirmed));
    }
    let value = string(response.get("value"));
    match dialog.kind {
        DialogKind::Input | DialogKind::Editor => {
            return frame(AnswerResponse::Value(value?.to_owned()));
        }
        DialogKind::Approval | DialogKind::Select => {
            let value = value?;
            if !dialog
                .options
                .as_ref()
                .is_some_and(|options| options.iter().any(|o| o == value))
            {
                return None;
            }
            if dialog.kind == DialogKind::Approval
                && !matches!(value, "Deny" | "Approve Once" | "Approve")
            {
                return None;
            }
            return frame(AnswerResponse::Value(value.to_owned()));
        }
        _ => {}
    }
    let answers = response.get("answers")?.as_array()?;
    let questions = dialog.questions.as_ref()?;
    if answers.len() != questions.len() {
        return None;
    }
    let valid = questions
        .iter()
        .zip(answers)
        .map(|(question, answer)| answer_item(question, answer))
        .collect::<Option<_>>()?;
    frame(AnswerResponse::Answers(valid))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum HarnessRole {
    Lead,
    Duty,
}

/// `Broker.harnessRole`: the reservation roles that run as a Cataly harness session.
pub(super) fn harness_role(reservation_role: &str) -> Option<HarnessRole> {
    match reservation_role {
        "lead" => Some(HarnessRole::Lead),
        "duty" => Some(HarnessRole::Duty),
        _ => None,
    }
}

/// The `AgentStatus` values a native host reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Error,
    Unknown,
}

/// `HeadlessObservation` in `Broker.snapshot`'s emission order. Serialize it directly (never through
/// `serde_json::Value`, whose map is sorted in this build).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Observation {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    reference: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<Json>,
    updated_at: String,
    status: AgentStatus,
    held: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<CatalyRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    harness_role: Option<HarnessRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    goal: Option<Goal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    dialogs: Vec<Dialog>,
    recent: Vec<Entry>,
}

/// The broker state `Broker.snapshot(state)` reads. `reference`, `cwd` and `started_at` are the reservation's raw
/// values, echoed verbatim; an absent one (`undefined`) omits its key.
pub(super) struct Snapshot<'a> {
    pub(super) reference: Option<&'a Json>,
    pub(super) cwd: Option<&'a Json>,
    pub(super) started_at: Option<&'a Json>,
    /// The OMP child's pid (`rpc.pid`), never the host's.
    pub(super) pid: Option<u32>,
    pub(super) harness_role: Option<HarnessRole>,
    /// The proven identity (`this.bound`).
    pub(super) bound: Option<&'a NativeState>,
    /// The `state` argument: the readback this observation answers for (`undefined` while held or unread).
    pub(super) state: Option<&'a NativeState>,
    /// The last successful readback (`this.state`), which supplies goal and model.
    pub(super) latest: Option<&'a NativeState>,
    pub(super) fault: bool,
    pub(super) stopping: bool,
    pub(super) detail: Option<&'a str>,
    pub(super) events: &'a Events,
}

/// `Broker.snapshot`: status precedence is error, blocked, unknown, idle, working; identity fields appear only for a
/// proven, unfaulted session with a readback.
pub(super) fn snapshot(input: &Snapshot<'_>) -> Observation {
    let dialogs = input.events.has_dialogs();
    let held =
        dialogs || input.fault || input.stopping || input.state.is_none() || input.bound.is_none();
    let status = if input.fault {
        AgentStatus::Error
    } else if dialogs
        || input
            .state
            .is_some_and(|state| state.goal.status == GoalStatus::Blocked)
    {
        AgentStatus::Blocked
    } else if input.bound.is_none() || input.stopping {
        AgentStatus::Unknown
    } else {
        match input.state {
            None => AgentStatus::Unknown,
            Some(state) if state.settled => AgentStatus::Idle,
            Some(_) => AgentStatus::Working,
        }
    };
    let identity = input.bound.zip(input.latest).filter(|_| !input.fault);
    Observation {
        reference: input.reference.cloned(),
        cwd: input.cwd.cloned(),
        started_at: input.started_at.cloned(),
        updated_at: util::iso(util::now_ms()),
        status,
        held,
        pid: input.pid,
        role: identity.map(|_| {
            if input.harness_role.is_some() {
                CatalyRole::Cataly
            } else {
                CatalyRole::Lane
            }
        }),
        harness_role: identity.and(input.harness_role),
        session_id: identity.map(|(bound, _)| bound.session_id.clone()),
        session_file: identity.map(|(bound, _)| bound.session_file.clone()),
        goal: identity.map(|(_, latest)| latest.goal.clone()),
        model: identity.and_then(|(_, latest)| latest.model.clone()),
        active_since: input.events.active_since(),
        detail: input.detail.map(str::to_owned),
        dialogs: input.events.dialogs().to_vec(),
        recent: input.events.recent().cloned().collect(),
    }
}

/// An optional `expectedSessionId` as `check(expected)` reads it: `expected !== undefined && expected !== bound`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Expected {
    /// Absent: any bound session.
    Unconstrained,
    Session(String),
    /// Present but not a string (including `null`): never the bound session.
    Never,
}

impl Expected {
    fn of(value: Option<&Value>) -> Self {
        match value {
            None => Self::Unconstrained,
            Some(Value::String(session)) => Self::Session(session.clone()),
            Some(_) => Self::Never,
        }
    }

    pub(super) fn admits(&self, bound: &str) -> bool {
        match self {
            Self::Unconstrained => true,
            Self::Session(session) => session == bound,
            Self::Never => false,
        }
    }
}

/// `deliverLocal`'s effective `when`: `strictIdle ? "idle" : (when ?? "idle")`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DeliverWhen {
    Idle,
    Working,
    Any,
    /// Any other value, which no delivery status equals.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DeliverOptions {
    pub(super) expected_session_id: Expected,
    pub(super) when: DeliverWhen,
}

impl DeliverOptions {
    /// `when === "any" || status === when` for the delivery status (idle, working or blocked).
    pub(super) fn when_admits(&self, status: AgentStatus) -> bool {
        match self.when {
            DeliverWhen::Any => true,
            DeliverWhen::Idle => status == AgentStatus::Idle,
            DeliverWhen::Working => status == AgentStatus::Working,
            DeliverWhen::Other => false,
        }
    }
}

/// `request.options.expectedSessionId` with `null`/absent options: Bun's exact `TypeError` text.
const DELIVER_OPTIONS_NULL: &str =
    "null is not an object (evaluating 'request.options.expectedSessionId')";
const DELIVER_OPTIONS_UNDEFINED: &str =
    "undefined is not an object (evaluating 'request.options.expectedSessionId')";

fn deliver_options(value: Option<&Value>) -> Result<DeliverOptions, &'static str> {
    let options = match value {
        None => return Err(DELIVER_OPTIONS_UNDEFINED),
        Some(Value::Null) => return Err(DELIVER_OPTIONS_NULL),
        Some(options) => options,
    };
    let when = if truthy(options.get("strictIdle")) {
        DeliverWhen::Idle
    } else {
        match options.get("when") {
            None | Some(Value::Null) => DeliverWhen::Idle,
            Some(Value::String(when)) => match when.as_str() {
                "idle" => DeliverWhen::Idle,
                "working" => DeliverWhen::Working,
                "any" => DeliverWhen::Any,
                _ => DeliverWhen::Other,
            },
            Some(_) => DeliverWhen::Other,
        }
    };
    Ok(DeliverOptions {
        expected_session_id: Expected::of(options.get("expectedSessionId")),
        when,
    })
}

/// `!text.trim()` on a non-string `text`: Bun's exact `TypeError` text.
fn deliver_text(value: Option<&Value>) -> Result<String, &'static str> {
    match value {
        Some(Value::String(text)) => Ok(text.clone()),
        None => Err("undefined is not an object (evaluating 'text.trim')"),
        Some(Value::Null) => Err("null is not an object (evaluating 'text.trim')"),
        Some(_) => Err("text.trim is not a function. (In 'text.trim()', 'text.trim' is undefined)"),
    }
}

/// `setNativeGoal`'s target. Any value but `"paused"` requests `resume`, and only `"paused"`/`"active"` can be reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GoalTarget {
    Paused,
    Active,
    Other,
}

impl GoalTarget {
    fn of(value: Option<&Value>) -> Self {
        match string(value) {
            Some("paused") => Self::Paused,
            Some("active") => Self::Active,
            _ => Self::Other,
        }
    }

    /// The `goal` RPC `op` for this target.
    pub(super) const fn op(self) -> &'static str {
        match self {
            Self::Paused => "pause",
            Self::Active | Self::Other => "resume",
        }
    }

    /// `status === target`.
    pub(super) fn reached(self, status: GoalStatus) -> bool {
        match self {
            Self::Paused => status == GoalStatus::Paused,
            Self::Active => status == GoalStatus::Active,
            Self::Other => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Delivery {
    Prompt,
    Steer,
}

impl Delivery {
    /// The wire spelling, also the digest prefix `${delivery}\0`.
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Steer => "steer",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RemoteInput {
    pub(super) id: String,
    pub(super) text: String,
    pub(super) delivery: Delivery,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ModelSelector {
    pub(super) model: String,
    pub(super) provider: String,
    pub(super) model_id: String,
}

/// A remote command after the session check. Each `Err` is the exact TypeScript text, raised (send, receipt) or
/// returned as the refusal `reason` (model, close) at the point the TypeScript applies it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RemoteCommand {
    Send(Result<RemoteInput, &'static str>),
    Receipt(Result<String, &'static str>),
    Interrupt,
    Model(Result<ModelSelector, &'static str>),
    Close(Result<bool, &'static str>),
}

const REMOTE_SEND_INVALID: &str =
    "Native send requires a request ID, at most 32 KiB of text, and prompt or steer delivery";
const REMOTE_TEXT_BYTES: usize = 32 * 1024;
const MODEL_UNITS: usize = 256;

/// `validId`: `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
fn valid_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && id.len() <= 128
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn remote_input(value: Option<&Value>) -> Result<RemoteInput, &'static str> {
    // `const { id, text, delivery = "prompt" } = input` on null/undefined.
    let input = value
        .filter(|input| !input.is_null())
        .ok_or("Cannot destructure property 'id' from null or undefined value")?;
    let id = string(input.get("id")).filter(|id| valid_id(id));
    let text =
        string(input.get("text")).filter(|text| !is_blank(text) && text.len() <= REMOTE_TEXT_BYTES);
    let delivery = input
        .get("delivery")
        .map_or(Some(Delivery::Prompt), |delivery| match delivery.as_str() {
            Some("prompt") => Some(Delivery::Prompt),
            Some("steer") => Some(Delivery::Steer),
            _ => None,
        });
    match (id, text, delivery) {
        (Some(id), Some(text), Some(delivery)) => Ok(RemoteInput {
            id: id.to_owned(),
            text: text.to_owned(),
            delivery,
        }),
        _ => Err(REMOTE_SEND_INVALID),
    }
}

/// `/^([^/\s]+)\/(\S+)$/` on a string of at most 256 UTF-16 units.
fn model_selector(value: Option<&Value>) -> Result<ModelSelector, &'static str> {
    const REFUSED: &str = "Model must be an exact provider/id";
    let model = string(value)
        .filter(|model| utf16_len(model) <= MODEL_UNITS)
        .ok_or(REFUSED)?;
    let (provider, model_id) = model.split_once('/').ok_or(REFUSED)?;
    if provider.is_empty() || model_id.is_empty() || model.contains(is_js_space) {
        return Err(REFUSED);
    }
    Ok(ModelSelector {
        model: model.to_owned(),
        provider: provider.to_owned(),
        model_id: model_id.to_owned(),
    })
}

/// `HeadlessRequest`, decoded with the TypeScript's field semantics but not validated: each check stays where the
/// broker applies it, so precedence and error text match.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Request {
    Observe,
    Deliver {
        /// `Err`: the `TypeError` `!text.trim()` raises once delivery is otherwise admissible.
        text: Result<String, &'static str>,
        /// `Err`: the `TypeError` reading `request.options.expectedSessionId`, raised inside the exclusive section.
        options: Result<DeliverOptions, &'static str>,
    },
    Begin {
        expected_session_id: Option<String>,
        objective: Option<String>,
    },
    Goal {
        expected_session_id: Expected,
        target: GoalTarget,
    },
    Answer {
        /// Compared with `!==`: absent or non-string never matches.
        expected_session_id: Option<String>,
        request_id: Option<String>,
        /// The raw answer (`Null` when absent) for `answer_frame`.
        answer: Value,
    },
    Close {
        expected_session_id: Expected,
    },
    Remote {
        /// Compared with `!==`: absent or non-string never matches.
        expected_session_id: Option<String>,
        command: RemoteCommand,
    },
    /// `stop-loop` and unknown ops: "Unsupported headless operation" inside the exclusive section.
    Unsupported,
}

/// The server's admission: `None` (HTTP 400) unless the body is an object with a string `op`.
pub(super) fn parse_request(body: &Value) -> Option<Request> {
    let request = body.as_object()?;
    let field = |key: &str| request.get(key);
    let owned = |key: &str| string(field(key)).map(str::to_owned);
    let remote = |command| Request::Remote {
        expected_session_id: owned("expectedSessionId"),
        command,
    };
    Some(match string(field("op"))? {
        "observe" => Request::Observe,
        "deliver" => Request::Deliver {
            text: deliver_text(field("text")),
            options: deliver_options(field("options")),
        },
        "begin" => Request::Begin {
            expected_session_id: owned("expectedSessionId"),
            objective: owned("objective"),
        },
        "goal" => Request::Goal {
            expected_session_id: Expected::of(field("expectedSessionId")),
            target: GoalTarget::of(field("target")),
        },
        "answer" => Request::Answer {
            expected_session_id: owned("expectedSessionId"),
            request_id: owned("requestId"),
            answer: field("answer").cloned().unwrap_or(Value::Null),
        },
        "close" => Request::Close {
            expected_session_id: Expected::of(field("expectedSessionId")),
        },
        "remote-send" => remote(RemoteCommand::Send(remote_input(field("input")))),
        "remote-receipt" => remote(RemoteCommand::Receipt(
            owned("id")
                .filter(|id| valid_id(id))
                .ok_or("Native receipt requires a request ID"),
        )),
        "remote-interrupt" => remote(RemoteCommand::Interrupt),
        "remote-model" => remote(RemoteCommand::Model(model_selector(field("model")))),
        "remote-close" => remote(RemoteCommand::Close(
            field("force")
                .and_then(Value::as_bool)
                .ok_or("Invalid close force flag"),
        )),
        _ => Request::Unsupported,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // test/fixtures/headless-rpc.ts "request approval" and "request question".
    fn fixture_approval() -> Value {
        json!({
            "type": "extension_ui_request",
            "id": "approval-1",
            "method": "select",
            "title": "Approve this fake write?",
            "options": ["Approve Once", "Approve for this session", "Deny"],
        })
    }

    fn fixture_question() -> Value {
        json!({
            "type": "extension_ui_request",
            "id": "question-1",
            "method": "ask",
            "questions": [{ "id": "single", "question": "Which option?", "options": [{ "label": "A" }, { "label": "B" }] }],
        })
    }

    fn dialog(frame: &Value) -> Dialog {
        dialog_of(frame).expect("dialog")
    }

    fn sent(dialog: &Dialog, answer: &Value) -> Option<String> {
        answer_frame(dialog, answer).map(|frame| serde_json::to_string(&frame).unwrap())
    }

    #[test]
    fn approval_dialog_matches_the_fixture_shape() {
        let approval = dialog(&fixture_approval());
        assert_eq!(
            serde_json::to_string(&approval).unwrap(),
            r#"{"id":"approval-1","title":"Approve this fake write?","kind":"approval","options":["Approve Once","Approve for this session","Deny"]}"#
        );
    }

    #[test]
    fn only_deny_with_a_single_call_approval_is_an_approval() {
        let kind = |options: Value| {
            dialog(&json!({ "id": "d", "method": "select", "options": options })).kind
        };
        assert_eq!(kind(json!(["Approve", "Deny"])), DialogKind::Approval);
        assert_eq!(kind(json!(["Deny", "Approve Once"])), DialogKind::Approval);
        assert_eq!(
            kind(json!(["Approve Once", "Approve for this session"])),
            DialogKind::Select
        );
        assert_eq!(
            kind(json!(["Deny", "Approve for this session"])),
            DialogKind::Select
        );
        assert_eq!(kind(json!(["Yes", "No"])), DialogKind::Select);
        assert_eq!(kind(json!("Deny,Approve")), DialogKind::Select);
        let mixed = dialog(
            &json!({ "id": "d", "method": "select", "options": ["Deny", 1, null, "Approve"] }),
        );
        assert_eq!(mixed.kind, DialogKind::Approval);
        assert_eq!(
            mixed.options,
            Some(vec!["Deny".to_owned(), "Approve".to_owned()])
        );
    }

    // test/runtime-headless.test.ts: "Approve for this session" is unsupported, "Deny" is submitted once.
    #[test]
    fn approvals_answer_one_call_and_never_grant_a_session() {
        let approval = dialog(&fixture_approval());
        assert_eq!(
            sent(&approval, &json!({ "value": "Approve for this session" })),
            None
        );
        assert_eq!(
            sent(&approval, &json!({ "value": "Deny" })).as_deref(),
            Some(r#"{"type":"extension_ui_response","id":"approval-1","value":"Deny"}"#)
        );
        assert!(sent(&approval, &json!({ "value": "Approve Once" })).is_some());
        // Recognized wording that this dialog did not offer.
        assert_eq!(sent(&approval, &json!({ "value": "Approve" })), None);
        let wide = dialog(&json!({
            "id": "w", "method": "select", "options": ["Approve", "Always approve", "Approve for this session", "Deny"],
        }));
        assert!(sent(&wide, &json!({ "value": "Approve" })).is_some());
        assert_eq!(sent(&wide, &json!({ "value": "Always approve" })), None);
        // Plain selects accept any offered option.
        let select = dialog(
            &json!({ "id": "s", "method": "select", "options": ["Always approve", "Other"] }),
        );
        assert!(sent(&select, &json!({ "value": "Always approve" })).is_some());
        assert_eq!(sent(&select, &json!({ "value": "Missing" })), None);
    }

    #[test]
    fn answers_of_the_wrong_kind_or_with_extra_fields_are_refused() {
        let approval = dialog(&fixture_approval());
        for answer in [
            json!({ "value": "Deny", "timedOut": true }),
            json!({ "timedOut": true }),
            json!({}),
            json!({ "confirmed": true }),
            json!({ "value": 1 }),
            json!({ "answers": [] }),
            json!({ "cancelled": false }),
            json!(["Deny"]),
            json!("Deny"),
            Value::Null,
        ] {
            assert_eq!(sent(&approval, &answer), None, "{answer}");
        }
        assert_eq!(
            sent(&approval, &json!({ "cancelled": true })).as_deref(),
            Some(r#"{"type":"extension_ui_response","id":"approval-1","cancelled":true}"#)
        );
        let confirm = dialog(&json!({ "id": "c", "method": "confirm", "title": "Sure?" }));
        assert_eq!(
            sent(&confirm, &json!({ "confirmed": false })).as_deref(),
            Some(r#"{"type":"extension_ui_response","id":"c","confirmed":false}"#)
        );
        assert_eq!(sent(&confirm, &json!({ "confirmed": "yes" })), None);
        assert_eq!(sent(&confirm, &json!({ "value": "yes" })), None);
        let editor = dialog(&json!({ "id": "e", "method": "editor" }));
        assert!(sent(&editor, &json!({ "value": "" })).is_some());
        assert_eq!(sent(&editor, &json!({ "confirmed": true })), None);
        let question = dialog(&fixture_question());
        assert_eq!(sent(&question, &json!({ "value": "B" })), None);
    }

    #[test]
    fn secret_input_is_only_cancellable() {
        let input =
            dialog(&json!({ "id": "i", "method": "input", "title": "Token", "secret": true }));
        assert_eq!(
            serde_json::to_string(&input).unwrap(),
            r#"{"id":"i","title":"Token","kind":"input","secret":true}"#
        );
        assert_eq!(sent(&input, &json!({ "value": "hunter2" })), None);
        assert!(sent(&input, &json!({ "cancelled": true })).is_some());
        let plain = dialog(&json!({ "id": "i", "method": "input", "secret": "yes" }));
        assert_eq!(
            serde_json::to_string(&plain).unwrap(),
            r#"{"id":"i","kind":"input"}"#
        );
        assert_eq!(
            sent(&plain, &json!({ "value": "text" })).as_deref(),
            Some(r#"{"type":"extension_ui_response","id":"i","value":"text"}"#)
        );
    }

    #[test]
    fn unknown_ui_is_unsupported_unanswerable_and_hides_content() {
        let url = dialog(
            &json!({ "id": "u", "method": "open_url", "title": "Open", "url": "https://example.test" }),
        );
        assert_eq!(
            serde_json::to_string(&url).unwrap(),
            r#"{"id":"u","kind":"unsupported"}"#
        );
        assert_eq!(sent(&url, &json!({ "cancelled": true })), None);
        assert_eq!(
            sent(&url, &json!({ "value": "https://example.test" })),
            None
        );
        assert_eq!(dialog(&json!({ "id": "m" })).kind, DialogKind::Unsupported);
        assert_eq!(
            dialog(&json!({ "id": "m", "method": 1 })).kind,
            DialogKind::Unsupported
        );
        for method in [
            "cancel",
            "notify",
            "setStatus",
            "setWidget",
            "setTitle",
            "set_editor_text",
        ] {
            assert_eq!(
                dialog_of(&json!({ "id": "n", "method": method })),
                None,
                "{method}"
            );
        }
        assert_eq!(dialog_of(&json!({ "method": "confirm" })), None);
        assert_eq!(dialog_of(&json!({ "id": "", "method": "confirm" })), None);
        assert_eq!(dialog_of(&json!({ "id": 1, "method": "confirm" })), None);
    }

    #[test]
    fn ask_dialogs_keep_only_well_formed_questions() {
        let ask = dialog(&json!({
            "id": "a", "method": "ask", "title": "dropped",
            "questions": [
                { "id": "q", "question": "", "options": [{ "label": "A" }, { "label": 2 }, "B", {}], "multi": true },
                { "id": "", "question": "no id" },
                { "id": "x", "question": 1 },
                "q",
            ],
        }));
        assert_eq!(
            serde_json::to_string(&ask).unwrap(),
            r#"{"id":"a","kind":"ask","questions":[{"id":"q","question":"","options":["A"],"multi":true}]}"#
        );
        let empty = dialog(
            &json!({ "id": "a", "method": "ask", "questions": [{ "id": "", "question": "q" }] }),
        );
        assert_eq!(empty.kind, DialogKind::Unsupported);
        assert_eq!(
            dialog(&json!({ "id": "a", "method": "ask", "questions": {} })).kind,
            DialogKind::Unsupported
        );
    }

    // test/runtime-headless.test.ts: a missing option is unsupported, "B" is submitted.
    #[test]
    fn ask_answers_must_select_offered_options_per_question() {
        let question = dialog(&fixture_question());
        let one = |answer: Value| sent(&question, &json!({ "answers": [answer] }));
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": ["wrong"] })),
            None
        );
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": ["B"] })).as_deref(),
            Some(
                r#"{"type":"extension_ui_response","id":"question-1","answers":[{"id":"single","selectedOptions":["B"]}]}"#
            )
        );
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": ["A", "B"] })),
            None
        );
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": ["A"], "customInput": "C" })),
            None
        );
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": ["A"], "customInput": "  " }))
                .as_deref(),
            Some(
                r#"{"type":"extension_ui_response","id":"question-1","answers":[{"id":"single","selectedOptions":["A"],"customInput":"  "}]}"#
            )
        );
        assert!(
            one(json!({ "id": "single", "selectedOptions": [], "customInput": "C" })).is_some()
        );
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": [], "customInput": "\u{feff}" })),
            None
        );
        assert_eq!(one(json!({ "id": "single", "selectedOptions": [] })), None);
        assert_eq!(
            one(json!({ "id": "single", "selectedOptions": ["A"], "customInput": null })),
            None
        );
        assert_eq!(
            one(json!({ "id": "other", "selectedOptions": ["A"] })),
            None
        );
        assert_eq!(one(json!({ "selectedOptions": ["A"] })), None);
        assert_eq!(one(json!({ "id": "single", "selectedOptions": "A" })), None);
        assert_eq!(one(json!({ "id": "single", "selectedOptions": [1] })), None);
        assert_eq!(one(json!("single")), None);
        assert_eq!(sent(&question, &json!({ "answers": [] })), None);
        let answer = json!({ "id": "single", "selectedOptions": ["A"] });
        assert_eq!(
            sent(&question, &json!({ "answers": [answer.clone(), answer] })),
            None
        );
        let multi = dialog(&json!({
            "id": "m", "method": "ask",
            "questions": [{ "id": "q", "question": "?", "options": [{ "label": "A" }, { "label": "B" }], "multi": true }],
        }));
        let pick = |answer: Value| sent(&multi, &json!({ "answers": [answer] }));
        assert!(
            pick(json!({ "id": "q", "selectedOptions": ["A", "B"], "customInput": "C" })).is_some()
        );
        assert_eq!(
            pick(json!({ "id": "q", "selectedOptions": ["A", "A"] })),
            None
        );
    }

    #[test]
    fn entries_keep_assistant_text_output_and_notices() {
        let assistant = json!({
            "type": "message_end",
            "message": { "role": "assistant", "content": [
                { "type": "text", "text": "[CATALY message]\n" }, { "type": "toolCall", "text": "skip" },
                { "type": "text", "text": "/only-literal" }, { "type": "text", "text": 1 },
            ] },
        });
        assert_eq!(
            serde_json::to_string(&entry_of(&assistant).unwrap()).unwrap(),
            r#"{"kind":"assistant","text":"[CATALY message]\n/only-literal"}"#
        );
        let user = json!({ "type": "message_end", "message": { "role": "user", "content": [{ "type": "text", "text": "x" }] } });
        assert_eq!(entry_of(&user), None);
        let string_content =
            json!({ "type": "message_end", "message": { "role": "assistant", "content": "x" } });
        assert_eq!(entry_of(&string_content), None);
        let output = entry_of(&json!({ "type": "command_output", "text": "done" })).unwrap();
        assert_eq!(
            (output.kind, output.text.as_str()),
            (EntryKind::Output, "done")
        );
        let notice = entry_of(
            &json!({ "type": "extension_ui_request", "method": "notify", "message": "hi" }),
        )
        .unwrap();
        assert_eq!(notice.kind, EntryKind::Notice);
        assert_eq!(
            entry_of(
                &json!({ "type": "extension_ui_request", "method": "confirm", "message": "hi" })
            ),
            None
        );
        assert_eq!(
            entry_of(&json!({ "type": "command_output", "text": " \n\u{feff}" })),
            None
        );
        assert_eq!(
            entry_of(&json!({ "type": "command_output", "text": 1 })),
            None
        );
        assert_eq!(entry_of(&json!({ "type": "agent_start" })), None);
    }

    #[test]
    fn entries_strip_control_characters_and_keep_the_last_2000_units() {
        let text = |raw: &str| {
            entry_of(&json!({ "type": "command_output", "text": raw })).map(|entry| entry.text)
        };
        assert_eq!(
            text("a\u{0}b\u{7f}\u{85}\u{9f}\n\t\r\u{1b}[0m").as_deref(),
            Some("ab\n\t[0m")
        );
        // JS trim keeps U+0085, so the entry survives as empty text once the control character is removed.
        assert_eq!(text("\u{85}").as_deref(), Some(""));
        let long = format!("{}{}", "a".repeat(500), "b".repeat(2_000));
        assert_eq!(text(&long), Some("b".repeat(2_000)));
        let wide = format!("x{}", "\u{1F600}".repeat(1_000));
        assert_eq!(text(&wide), Some("\u{1F600}".repeat(1_000)));
        // A split surrogate pair loses its orphaned low half.
        let split = format!("\u{1F600}{}", "y".repeat(1_999));
        assert_eq!(text(&split), Some("y".repeat(1_999)));
        let stripped_first = format!("{}{}", "z".repeat(2_000), "\u{0}".repeat(10));
        assert_eq!(text(&stripped_first), Some("z".repeat(2_000)));
    }

    #[test]
    fn goals_and_models_read_like_omp_reports_them() {
        let none = Goal {
            status: GoalStatus::None,
            objective: None,
        };
        assert_eq!(goal_of(Some(&Value::Null)), Some(none));
        assert_eq!(goal_of(None), None);
        assert_eq!(goal_of(Some(&json!({}))), None);
        assert_eq!(goal_of(Some(&json!({ "goal": null }))), None);
        assert_eq!(
            goal_of(Some(&json!({ "goal": { "status": "waiting" } }))),
            None
        );
        let blocked = goal_of(Some(
            &json!({ "goal": { "status": "budget-limited", "objective": "o" } }),
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&blocked).unwrap(),
            r#"{"status":"blocked","objective":"o"}"#
        );
        let active = goal_of(Some(
            &json!({ "goal": { "status": "active", "objective": 1 } }),
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&active).unwrap(),
            r#"{"status":"active"}"#
        );
        for status in ["paused", "complete", "dropped"] {
            assert!(goal_of(Some(&json!({ "goal": { "status": status } }))).is_some());
        }
        assert_eq!(
            model_of(Some(&json!({ "provider": "fixture", "id": "initial" }))).as_deref(),
            Some("fixture/initial")
        );
        assert_eq!(
            model_of(Some(&json!({ "provider": "a/b", "id": "c" }))),
            None
        );
        assert_eq!(model_of(Some(&json!({ "provider": "", "id": "c" }))), None);
        assert_eq!(model_of(Some(&json!({ "provider": "a", "id": "" }))), None);
        assert_eq!(model_of(Some(&json!("a/b"))), None);
    }

    #[test]
    fn cataly_roles_and_entries_are_exact() {
        assert_eq!(
            parse_cataly_role(Some(&json!("cataly"))),
            Some(CatalyRole::Cataly)
        );
        assert_eq!(
            parse_cataly_role(Some(&json!("lane"))),
            Some(CatalyRole::Lane)
        );
        assert_eq!(parse_cataly_role(Some(&json!("Cataly"))), None);
        assert_eq!(parse_cataly_role(Some(&json!({ "role": "lane" }))), None);
        assert_eq!(parse_cataly_role(None), None);
        let entries = json!({ "entries": [
            { "type": "custom", "customType": "omp-cataly:role", "data": "lane" },
            { "type": "message", "customType": "omp-cataly:role", "data": "lane" },
            { "type": "custom", "customType": "omp-other:role", "data": "lane" },
            { "type": "custom", "customType": "omp-cataly:harness-role" },
            "custom",
        ] });
        assert_eq!(
            last_custom_data(Some(&entries), "omp-cataly:role"),
            Some(&json!("lane"))
        );
        assert_eq!(
            last_custom_data(Some(&entries), "omp-cataly:harness-role"),
            None
        );
        assert_eq!(
            last_custom_data(Some(&json!({ "entries": {} })), "omp-cataly:role"),
            None
        );
        assert_eq!(last_custom_data(None, "omp-cataly:role"), None);
    }

    // test/fixtures/headless-rpc.ts get_state.
    fn fixture_state(settled: bool) -> Value {
        json!({
            "sessionId": "fixture-session", "sessionFile": "/fixture/session.jsonl", "isSettled": settled,
            "isStreaming": !settled, "goal": { "goal": { "status": "active", "objective": "o" } },
            "model": { "provider": "fixture", "id": "initial" },
        })
    }

    #[test]
    fn native_state_requires_identity_goal_and_settlement() {
        let state = native_state_of(Some(&fixture_state(false))).unwrap();
        assert_eq!(state.session_id, "fixture-session");
        assert!(state.foreground && !state.settled);
        assert_eq!(state.model.as_deref(), Some("fixture/initial"));
        let mut data = fixture_state(true);
        data["goal"] = Value::Null;
        data["isCompacting"] = json!(true);
        data["model"] = json!({ "provider": "a/b", "id": "c" });
        let state = native_state_of(Some(&data)).unwrap();
        assert_eq!(
            (state.goal.status, state.foreground, state.model),
            (GoalStatus::None, true, None)
        );
        for key in ["sessionId", "sessionFile", "goal", "isSettled"] {
            let mut data = fixture_state(true);
            data.as_object_mut().unwrap().remove(key);
            assert_eq!(native_state_of(Some(&data)), None, "{key}");
        }
        let mut data = fixture_state(true);
        data["isSettled"] = json!(1);
        assert_eq!(native_state_of(Some(&data)), None);
        data["isSettled"] = json!(true);
        data["sessionId"] = json!("");
        assert_eq!(native_state_of(Some(&data)), None);
        assert_eq!(native_state_of(None), None);
    }

    fn raw(text: &str) -> Json {
        serde_json::from_str(text).unwrap()
    }

    struct Fixture {
        reference: Json,
        cwd: Json,
        started_at: Json,
        events: Events,
    }

    fn fixture() -> Fixture {
        Fixture {
            reference: raw(r#"{"runtime":"headless","id":"00000000-0000-4000-8000-000000000001"}"#),
            cwd: raw(r#""/fixture""#),
            started_at: raw(r#""2026-11-21T00:00:00.000Z""#),
            events: Events::default(),
        }
    }

    fn base<'a>(fixture: &'a Fixture, state: Option<&'a NativeState>) -> Snapshot<'a> {
        Snapshot {
            reference: Some(&fixture.reference),
            cwd: Some(&fixture.cwd),
            started_at: Some(&fixture.started_at),
            pid: Some(123),
            harness_role: None,
            bound: state,
            state,
            latest: state,
            fault: false,
            stopping: false,
            detail: None,
            events: &fixture.events,
        }
    }

    fn shown(input: &Snapshot<'_>) -> String {
        let mut observation = snapshot(input);
        observation.updated_at = "2026-11-21T00:00:01.000Z".to_owned();
        serde_json::to_string(&observation).unwrap()
    }

    // test/runtime-headless.test.ts "headless session resolution": the confirmed idle lane observation.
    #[test]
    fn observation_keeps_the_broker_emission_order() {
        let fixture = fixture();
        let mut state = native_state_of(Some(&fixture_state(true))).unwrap();
        state.goal.objective = None;
        assert_eq!(
            shown(&base(&fixture, Some(&state))),
            concat!(
                r#"{"ref":{"runtime":"headless","id":"00000000-0000-4000-8000-000000000001"},"cwd":"/fixture","#,
                r#""startedAt":"2026-11-21T00:00:00.000Z","updatedAt":"2026-11-21T00:00:01.000Z","status":"idle","#,
                r#""held":false,"pid":123,"role":"lane","sessionId":"fixture-session","#,
                r#""sessionFile":"/fixture/session.jsonl","goal":{"status":"active"},"model":"fixture/initial","#,
                r#""dialogs":[],"recent":[]}"#
            )
        );
        let observation = snapshot(&base(&fixture, Some(&state)));
        assert_eq!(
            observation.updated_at.len(),
            "2026-11-21T00:00:01.000Z".len()
        );
    }

    #[test]
    fn observation_echoes_raw_reservation_values_and_harness_roles() {
        let mut fixture = fixture();
        fixture.reference = raw(r#"{"id":"x","runtime":"headless","group":"g"}"#);
        fixture.cwd = raw("7");
        fixture
            .events
            .record(&json!({ "type": "command_output", "text": "out" }));
        let state = native_state_of(Some(&fixture_state(false))).unwrap();
        let input = Snapshot {
            harness_role: Some(HarnessRole::Duty),
            detail: Some("note"),
            pid: None,
            ..base(&fixture, Some(&state))
        };
        let shown = shown(&input);
        assert!(
            shown.starts_with(r#"{"ref":{"id":"x","runtime":"headless","group":"g"},"cwd":7,"#),
            "{shown}"
        );
        assert!(
            shown.contains(r#""status":"working","held":false,"role":"cataly","harnessRole":"duty","sessionId""#),
            "{shown}"
        );
        assert!(
            shown.ends_with(
                r#""detail":"note","dialogs":[],"recent":[{"kind":"output","text":"out"}]}"#
            ),
            "{shown}"
        );
    }

    #[test]
    fn observation_status_and_hold_precedence() {
        let mut fixture = fixture();
        let idle = native_state_of(Some(&fixture_state(true))).unwrap();
        let mut blocked = idle.clone();
        blocked.goal.status = GoalStatus::Blocked;
        let observe = |input: &Snapshot<'_>| {
            let observation = snapshot(input);
            (
                observation.status,
                observation.held,
                observation.session_id.is_some(),
            )
        };
        assert_eq!(
            observe(&base(&fixture, Some(&idle))),
            (AgentStatus::Idle, false, true)
        );
        assert_eq!(
            observe(&base(&fixture, Some(&blocked))),
            (AgentStatus::Blocked, false, true)
        );
        let faulted = Snapshot {
            fault: true,
            ..base(&fixture, Some(&blocked))
        };
        assert_eq!(observe(&faulted), (AgentStatus::Error, true, false));
        let stopping = Snapshot {
            stopping: true,
            ..base(&fixture, Some(&idle))
        };
        assert_eq!(observe(&stopping), (AgentStatus::Unknown, true, true));
        let stopping_blocked = Snapshot {
            stopping: true,
            ..base(&fixture, Some(&blocked))
        };
        assert_eq!(
            observe(&stopping_blocked),
            (AgentStatus::Blocked, true, true)
        );
        let unread = Snapshot {
            state: None,
            ..base(&fixture, Some(&idle))
        };
        assert_eq!(observe(&unread), (AgentStatus::Unknown, true, true));
        let unproven = Snapshot {
            bound: None,
            ..base(&fixture, Some(&idle))
        };
        assert_eq!(observe(&unproven), (AgentStatus::Unknown, true, false));
        let never_read = Snapshot {
            latest: None,
            state: None,
            ..base(&fixture, Some(&idle))
        };
        assert_eq!(observe(&never_read), (AgentStatus::Unknown, true, false));
        fixture.events.record(&fixture_approval());
        let held = Snapshot {
            state: None,
            ..base(&fixture, Some(&idle))
        };
        assert_eq!(observe(&held), (AgentStatus::Blocked, true, true));
        let faulted_with_dialog = Snapshot {
            fault: true,
            ..base(&fixture, Some(&idle))
        };
        assert_eq!(
            observe(&faulted_with_dialog),
            (AgentStatus::Error, true, false)
        );
        let observation = snapshot(&base(&fixture, Some(&idle)));
        assert_eq!(observation.dialogs.len(), 1);
    }

    #[test]
    fn observation_omits_absent_reservation_values() {
        let fixture = fixture();
        let input = Snapshot {
            reference: None,
            cwd: None,
            started_at: None,
            pid: None,
            ..base(&fixture, None)
        };
        assert_eq!(
            shown(&input),
            r#"{"updatedAt":"2026-11-21T00:00:01.000Z","status":"unknown","held":true,"dialogs":[],"recent":[]}"#
        );
    }

    #[test]
    fn observation_reports_goal_and_model_from_the_latest_readback() {
        let fixture = fixture();
        let bound = native_state_of(Some(&fixture_state(true))).unwrap();
        let mut latest = bound.clone();
        latest.goal.status = GoalStatus::Paused;
        latest.model = None;
        let observation = snapshot(&Snapshot {
            latest: Some(&latest),
            state: None,
            ..base(&fixture, Some(&bound))
        });
        assert_eq!(
            observation.goal.map(|goal| goal.status),
            Some(GoalStatus::Paused)
        );
        assert_eq!(
            (observation.model, observation.status),
            (None, AgentStatus::Unknown)
        );
    }

    #[test]
    fn requests_need_an_object_with_a_string_op() {
        for body in [
            json!([]),
            json!("observe"),
            json!({}),
            json!({ "op": 1 }),
            json!({ "op": null }),
        ] {
            assert_eq!(parse_request(&body), None, "{body}");
        }
        assert_eq!(
            parse_request(&json!({ "op": "observe", "extra": 1 })),
            Some(Request::Observe)
        );
        assert_eq!(
            parse_request(&json!({ "op": "stop-loop" })),
            Some(Request::Unsupported)
        );
        assert_eq!(
            parse_request(&json!({ "op": "Observe" })),
            Some(Request::Unsupported)
        );
    }

    #[test]
    fn deliver_requests_keep_the_typescript_field_semantics() {
        let deliver = |options: Value| {
            parse_request(&json!({ "op": "deliver", "text": "hi", "options": options }))
        };
        let options = |options: Value| match deliver(options) {
            Some(Request::Deliver { options, .. }) => options,
            other => panic!("{other:?}"),
        };
        let when = |value: Value| options(value).map(|options| options.when);
        assert_eq!(when(json!({})), Ok(DeliverWhen::Idle));
        assert_eq!(when(json!({ "when": null })), Ok(DeliverWhen::Idle));
        assert_eq!(when(json!({ "when": "any" })), Ok(DeliverWhen::Any));
        assert_eq!(when(json!({ "when": "working" })), Ok(DeliverWhen::Working));
        assert_eq!(when(json!({ "when": "blocked" })), Ok(DeliverWhen::Other));
        assert_eq!(when(json!({ "when": 1 })), Ok(DeliverWhen::Other));
        assert_eq!(
            when(json!({ "when": "any", "strictIdle": true })),
            Ok(DeliverWhen::Idle)
        );
        assert_eq!(
            when(json!({ "when": "any", "strictIdle": 0 })),
            Ok(DeliverWhen::Any)
        );
        assert_eq!(
            when(json!({ "when": "any", "strictIdle": "" })),
            Ok(DeliverWhen::Any)
        );
        assert_eq!(
            when(json!({ "when": "any", "strictIdle": [] })),
            Ok(DeliverWhen::Idle)
        );
        assert_eq!(when(json!(5)), Ok(DeliverWhen::Idle));
        assert_eq!(
            options(Value::Null),
            Err("null is not an object (evaluating 'request.options.expectedSessionId')")
        );
        assert_eq!(
            parse_request(&json!({ "op": "deliver", "text": "hi" })),
            Some(Request::Deliver {
                text: Ok("hi".to_owned()),
                options: Err(
                    "undefined is not an object (evaluating 'request.options.expectedSessionId')"
                ),
            })
        );
        let session = |value: Value| {
            options(json!({ "expectedSessionId": value }))
                .unwrap()
                .expected_session_id
        };
        assert_eq!(session(json!("s")), Expected::Session("s".to_owned()));
        assert_eq!(session(Value::Null), Expected::Never);
        assert_eq!(
            options(json!({})).unwrap().expected_session_id,
            Expected::Unconstrained
        );
        let text = |body: Value| match parse_request(&body) {
            Some(Request::Deliver { text, .. }) => text,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            text(json!({ "op": "deliver", "options": {} })),
            Err("undefined is not an object (evaluating 'text.trim')")
        );
        assert_eq!(
            text(json!({ "op": "deliver", "text": null })),
            Err("null is not an object (evaluating 'text.trim')")
        );
        assert_eq!(
            text(json!({ "op": "deliver", "text": 5 })),
            Err("text.trim is not a function. (In 'text.trim()', 'text.trim' is undefined)")
        );
    }

    #[test]
    fn session_gates_and_targets_compare_like_the_broker() {
        assert!(Expected::Unconstrained.admits("s"));
        assert!(Expected::Session("s".to_owned()).admits("s"));
        assert!(!Expected::Session("t".to_owned()).admits("s"));
        assert!(!Expected::Never.admits("s"));
        let admits = |when: DeliverWhen, status| {
            DeliverOptions {
                expected_session_id: Expected::Unconstrained,
                when,
            }
            .when_admits(status)
        };
        assert!(admits(DeliverWhen::Any, AgentStatus::Blocked));
        assert!(
            admits(DeliverWhen::Idle, AgentStatus::Idle)
                && !admits(DeliverWhen::Idle, AgentStatus::Working)
        );
        assert!(
            admits(DeliverWhen::Working, AgentStatus::Working)
                && !admits(DeliverWhen::Other, AgentStatus::Idle)
        );
        let goal = |target: Value| match parse_request(&json!({ "op": "goal", "target": target })) {
            Some(Request::Goal {
                target,
                expected_session_id,
            }) => (target, expected_session_id),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            goal(json!("paused")),
            (GoalTarget::Paused, Expected::Unconstrained)
        );
        assert_eq!(goal(json!("active")).0, GoalTarget::Active);
        assert_eq!(goal(json!("Paused")).0, GoalTarget::Other);
        assert_eq!(
            (
                GoalTarget::Paused.op(),
                GoalTarget::Active.op(),
                GoalTarget::Other.op()
            ),
            ("pause", "resume", "resume")
        );
        assert!(
            GoalTarget::Paused.reached(GoalStatus::Paused)
                && GoalTarget::Active.reached(GoalStatus::Active)
        );
        assert!(
            !GoalTarget::Other.reached(GoalStatus::Active)
                && !GoalTarget::Active.reached(GoalStatus::None)
        );
        assert_eq!(
            parse_request(&json!({ "op": "close", "expectedSessionId": 1 })),
            Some(Request::Close {
                expected_session_id: Expected::Never
            })
        );
        assert_eq!(
            parse_request(&json!({ "op": "begin", "expectedSessionId": 1, "objective": "o" })),
            Some(Request::Begin {
                expected_session_id: None,
                objective: Some("o".to_owned())
            })
        );
        assert_eq!(
            parse_request(&json!({ "op": "answer", "expectedSessionId": "s", "requestId": 1 })),
            Some(Request::Answer {
                expected_session_id: Some("s".to_owned()),
                request_id: None,
                answer: Value::Null
            })
        );
    }

    fn remote(body: &Value) -> (Option<String>, RemoteCommand) {
        match parse_request(body) {
            Some(Request::Remote {
                expected_session_id,
                command,
            }) => (expected_session_id, command),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn remote_send_validates_id_text_and_delivery() {
        let send = |input: Value| {
            remote(&json!({ "op": "remote-send", "expectedSessionId": "s", "input": input })).1
        };
        let invalid = RemoteCommand::Send(Err(REMOTE_SEND_INVALID));
        assert_eq!(
            send(json!({ "id": "send-one", "text": "/close" })),
            RemoteCommand::Send(Ok(RemoteInput {
                id: "send-one".to_owned(),
                text: "/close".to_owned(),
                delivery: Delivery::Prompt,
            }))
        );
        let steer = send(json!({ "id": "a.b_c:d-e", "text": "steer this", "delivery": "steer" }));
        assert!(matches!(
            steer,
            RemoteCommand::Send(Ok(RemoteInput {
                delivery: Delivery::Steer,
                ..
            }))
        ));
        assert_eq!(Delivery::Steer.as_str(), "steer");
        let max = "x".repeat(32 * 1024);
        assert!(matches!(
            send(json!({ "id": "a", "text": max })),
            RemoteCommand::Send(Ok(_))
        ));
        for input in [
            json!({ "id": "a", "text": format!("{max}x") }),
            json!({ "id": "a", "text": "\u{feff} " }),
            json!({ "id": "a", "text": 1 }),
            json!({ "id": "a", "text": "t", "delivery": null }),
            json!({ "id": "a", "text": "t", "delivery": "follow_up" }),
            json!({ "id": "-a", "text": "t" }),
            json!({ "id": "a b", "text": "t" }),
            json!({ "id": "x".repeat(129), "text": "t" }),
            json!({ "id": "é", "text": "t" }),
            json!({ "text": "t" }),
            json!("input"),
        ] {
            assert_eq!(send(input.clone()), invalid, "{input}");
        }
        assert!(matches!(
            send(json!({ "id": "x".repeat(128), "text": "t" })),
            RemoteCommand::Send(Ok(_))
        ));
        let destructure = RemoteCommand::Send(Err(
            "Cannot destructure property 'id' from null or undefined value",
        ));
        assert_eq!(send(Value::Null), destructure);
        assert_eq!(
            remote(&json!({ "op": "remote-send", "expectedSessionId": "s" })).1,
            destructure
        );
    }

    #[test]
    fn remote_receipt_model_and_close_fields() {
        assert_eq!(
            remote(&json!({ "op": "remote-receipt", "expectedSessionId": "s", "id": "send-one" })),
            (
                Some("s".to_owned()),
                RemoteCommand::Receipt(Ok("send-one".to_owned()))
            )
        );
        let missing = RemoteCommand::Receipt(Err("Native receipt requires a request ID"));
        assert_eq!(
            remote(&json!({ "op": "remote-receipt", "id": "" })),
            (None, missing)
        );
        assert_eq!(
            remote(&json!({ "op": "remote-interrupt", "expectedSessionId": 7 })),
            (None, RemoteCommand::Interrupt)
        );
        let model = |value: Value| {
            remote(&json!({ "op": "remote-model", "expectedSessionId": "s", "model": value })).1
        };
        // test/runtime-headless-remote.test.ts: the id after the first slash may contain slashes.
        assert_eq!(
            model(json!("fixture/model/variant")),
            RemoteCommand::Model(Ok(ModelSelector {
                model: "fixture/model/variant".to_owned(),
                provider: "fixture".to_owned(),
                model_id: "model/variant".to_owned(),
            }))
        );
        let refused = RemoteCommand::Model(Err("Model must be an exact provider/id"));
        let long = format!("p/{}", "\u{1F600}".repeat(127));
        assert!(matches!(model(json!(long)), RemoteCommand::Model(Ok(_))));
        let too_long = format!("p/{}", "x".repeat(255));
        for value in [
            json!("fixture"),
            json!("/id"),
            json!("p/"),
            json!("p q/id"),
            json!("p/i d"),
            json!(1),
            json!(too_long),
        ] {
            assert_eq!(model(value.clone()), refused, "{value}");
        }
        assert!(matches!(
            model(json!(format!("p/{}", "x".repeat(254)))),
            RemoteCommand::Model(Ok(_))
        ));
        let close = |force: Value| {
            remote(&json!({ "op": "remote-close", "expectedSessionId": "s", "force": force })).1
        };
        assert_eq!(close(json!(true)), RemoteCommand::Close(Ok(true)));
        assert_eq!(
            close(json!("true")),
            RemoteCommand::Close(Err("Invalid close force flag"))
        );
        assert_eq!(
            remote(&json!({ "op": "remote-close" })).1,
            RemoteCommand::Close(Err("Invalid close force flag"))
        );
    }

    #[test]
    fn javascript_whitespace_is_trimmed() {
        assert!(is_blank("") && is_blank(" \t\n\r\u{b}\u{c}\u{a0}\u{2028}\u{3000}\u{feff}"));
        assert!(!is_blank("\u{85}") && !is_blank("\u{180e}") && !is_blank("x"));
        assert_eq!(js_trim_start("\u{feff} \n/cmd "), "/cmd ");
        assert_eq!(js_trim_start("\u{85}/cmd"), "\u{85}/cmd");
    }
}

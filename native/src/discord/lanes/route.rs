//! `discord-lane-routing.ts`: which registered lane owns a Discord channel, and enqueueing under its delivery lock.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;

use super::LaneHold;
use super::headless;
use super::lock::{Lock, take_lock};
use super::registry::{Lane, Registry, SessionRef, pane_state};
use super::wake::is_pending;
use crate::json::Json;
use crate::util::{safe_int, signalable};

/// `DELIVERY_WAIT_MS`.
pub(super) const DELIVERY_WAIT: Duration = Duration::from_secs(30);
const DELIVERY_RETRY: Duration = Duration::from_millis(50);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Route {
    Ambiguous,
    Closing(String),
    Inactive(String),
    NativeUnavailable(String),
    /// `session` is the pane's reported id exactly; a non-string id is `None`.
    Live {
        key: String,
        session: Option<String>,
    },
}

impl Route {
    const fn key(&self) -> Option<&str> {
        match self {
            Self::Ambiguous => None,
            Self::Closing(key)
            | Self::Inactive(key)
            | Self::NativeUnavailable(key)
            | Self::Live { key, .. } => Some(key.as_str()),
        }
    }

    const fn live(&self) -> bool {
        matches!(self, Self::Live { .. })
    }

    const fn unavailable(&self) -> bool {
        matches!(self, Self::NativeUnavailable(_))
    }
}

/// `openDiscordLanes`.
fn open_lanes(lanes: Vec<Lane>) -> Vec<Lane> {
    lanes
        .into_iter()
        .filter(|lane| lane.status() != "closed")
        .collect()
}

/// `other.sessionRef?.id === id && other.sessionRef.runtime === runtime`; an access TS would throw on is a conflict.
fn same_session_ref(lane: &Lane, other: &Lane) -> bool {
    let mine = lane.session_ref();
    let id = mine.as_ref().and_then(|r| r.id);
    let runtime = mine.as_ref().and_then(|r| r.runtime);
    let Some(theirs) = other
        .0
        .get("sessionRef")
        .filter(|r| !matches!(r, Json::Null))
    else {
        return id.is_none();
    };
    theirs.get("id") == id && theirs.get("runtime") == runtime
}

/// `matchingDiscordLane`.
fn matching(
    open: &[Lane],
    matches: impl Fn(&Lane) -> bool,
    allow_shared_channel: bool,
) -> Option<&Lane> {
    let mut found = open.iter().enumerate().filter(|(_, lane)| matches(lane));
    let (index, lane) = found.next()?;
    if found.next().is_some() || lane.session_ref().is_none() {
        return None;
    }
    let conflict = open.iter().enumerate().any(|(at, other)| {
        at != index
            && ((!allow_shared_channel && other.thread() == lane.thread())
                || same_session_ref(lane, other)
                || (lane.session_value().is_some()
                    && lane.session_value() == other.session_value()))
    });
    (!conflict).then_some(lane)
}

/// `uniqueDiscordLane(stateDir, lane => lane.thread === thread)`.
pub(super) fn unique(state: &Path, thread: &str) -> Result<Option<Lane>> {
    let scan = Registry::new(state).scan()?;
    if scan.unreadable > 0 {
        return Ok(None);
    }
    let open = open_lanes(scan.lanes);
    Ok(matching(&open, |lane| lane.thread_is(thread), false).cloned())
}

/// `discordLaneRoute(stateDir, channel)`.
pub(super) async fn classify(state: &Path, channel: &str) -> Result<Option<Route>> {
    let scan = Registry::new(state).scan()?;
    if scan.unreadable > 0 {
        return Ok(Some(Route::Ambiguous));
    }
    let thread = format!("discord:{channel}");
    let open = open_lanes(scan.lanes);
    if !open.iter().any(|lane| lane.thread_is(&thread)) {
        return Ok(None);
    }
    let Some(lane) = matching(&open, |lane| lane.thread_is(&thread), false) else {
        return Ok(Some(Route::Ambiguous));
    };
    let key = lane.key().to_owned();
    if lane.closing() {
        return Ok(Some(Route::Closing(key)));
    }
    let reference = lane.session_ref();
    if reference.as_ref().and_then(SessionRef::runtime) == Some("headless") {
        if let Some(session) = lane.session()
            && headless::available(state, lane).await?
        {
            return Ok(Some(Route::Live {
                key,
                session: Some(session.to_owned()),
            }));
        }
        return Ok(Some(Route::NativeUnavailable(key)));
    }
    // Only a Tern pane row can serve a non-native lane.
    let inactive = Ok(Some(Route::Inactive(key.clone())));
    if reference.as_ref().and_then(SessionRef::runtime) != Some("tern") {
        return inactive;
    }
    let Some(pane) = reference
        .as_ref()
        .and_then(SessionRef::id)
        .and_then(|id| pane_state(state, id))
    else {
        return inactive;
    };
    if pane.str("role") != Some("lane") || pane.get("discordLaneInbox") != Some(&Json::Bool(true)) {
        return inactive;
    }
    let pane_session = pane.get("sessionId");
    let active = Ok(Some(Route::Live {
        key,
        session: pane.str("sessionId").map(str::to_owned),
    }));
    let pid = pane.get("pid").and_then(Json::as_f64);
    if lane.session_value() == pane_session && pid == Some(0.0) {
        return active;
    }
    let other_session = lane.session_value() != pane_session
        && (lane.session_value().is_some() || pane.get("discordLaneKey") != lane.0.get("key"));
    if pid.is_some_and(|pid| pid <= 0.0) || other_session {
        return inactive;
    }
    if !pid.and_then(safe_int).is_some_and(signalable) {
        return inactive;
    }
    active
}

/// `withDeliveryLock`'s acquisition: `<state>/lanes/<key>.deliver.lock`, retried until `wait` elapses.
pub(super) async fn delivery_lock(state: &Path, key: &str, wait: Duration) -> Result<Option<Lock>> {
    let dir = Registry::new(state).dir;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{key}.deliver.lock"));
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if let Ok(lock) = take_lock(&path, true)? {
            return Ok(Some(lock));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(DELIVERY_RETRY).await;
    }
}

fn hold(reason: &str) -> anyhow::Error {
    LaneHold(format!("{reason}; cursor not advanced")).into()
}

/// The decision `enqueueDiscordLane` makes while holding the delivery lock.
async fn decide(state: &Path, channel: &str, route: &Route, wake: bool) -> Result<Option<String>> {
    let current = classify(state, channel).await?;
    if current == Some(Route::Ambiguous) {
        return Err(hold("Discord lane owner ambiguous"));
    }
    let Some(current) = current.filter(|current| current.key() == route.key()) else {
        return Err(hold("Discord lane route changed"));
    };
    if matches!(current, Route::Closing(_)) {
        return Err(hold("Discord lane native close is in progress"));
    }
    let mut session = match (route, &current) {
        (
            Route::Live {
                session: before, ..
            },
            Route::Live { session: now, .. },
        ) if before == now => now.clone(),
        _ => None,
    }
    .filter(|session| !session.is_empty());
    // A bound wake awaiting attestation still owns the exact thread and original session.
    if session.is_none()
        && wake
        && matches!(current, Route::Inactive(_) | Route::NativeUnavailable(_))
    {
        let lane = Registry::new(state).read(current.key().unwrap_or_default())?;
        if let Some(lane) = lane
            && lane.thread_is(&format!("discord:{channel}"))
            && is_pending(lane.epoch())
        {
            session = lane.session().map(str::to_owned);
        }
    }
    if session.is_none()
        && (route.live() || current.live() || route.unavailable() || current.unavailable())
    {
        return Err(hold("Discord native lane identity unverified"));
    }
    Ok(session)
}

/// `enqueueDiscordLane`: `Ok(true)` once `enqueue` stored the message for the owning lane session; `Ok(false)` when
/// no lane owns the channel; a `LaneHold` error for every race that must not advance the cursor.
pub(super) async fn enqueue(
    state: &Path,
    channel: &str,
    wake: bool,
    wait: Duration,
    enqueue: impl FnOnce(&str) -> Result<()> + Send,
) -> Result<bool> {
    let Some(route) = classify(state, channel).await? else {
        return Ok(false);
    };
    let Some(key) = route.key().map(str::to_owned) else {
        return Err(hold("Discord lane owner ambiguous"));
    };
    let Some(lock) = delivery_lock(state, &key, wait).await? else {
        return Err(hold("Discord lane delivery is locked"));
    };
    let result = match decide(state, channel, &route, wake).await {
        Ok(Some(session)) => enqueue(&session).map(|()| true),
        Ok(None) => Ok(false),
        Err(error) => Err(error),
    };
    let released = lock.release();
    let queued = result?;
    released?;
    Ok(queued)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::DirBuilderExt as _;
    use std::path::PathBuf;

    use super::*;
    use crate::util::uuid;

    struct State(PathBuf);

    impl State {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cataly-lane-route-{}", uuid().unwrap()));
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir.join("lanes"))
                .unwrap();
            Self(dir)
        }

        fn lane(&self, key: &str, body: &str) {
            fs::write(self.0.join("lanes").join(format!("{key}.json")), body).unwrap();
        }
    }

    impl Drop for State {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn tern(key: &str, channel: &str, pane: &str, session: &str) -> String {
        format!(
            r#"{{"key":"{key}","thread":"discord:{channel}","sessionRef":{{"runtime":"tern","id":"{pane}"}},"session":"{session}","openedAt":"2026-01-01T00:00:00.000Z","brief":"","done":"","title":""}}"#
        )
    }

    async fn route(state: &State, channel: &str) -> Option<Route> {
        classify(&state.0, channel).await.unwrap()
    }

    #[tokio::test]
    async fn unowned_channels_and_ignored_rows() {
        let state = State::new();
        assert_eq!(route(&state, "1").await, None);
        state.lane(
            "gone",
            &tern("gone", "1", "w1:p1", "s").replace(r#""title":"""#, r#""closedAt":"x""#),
        );
        assert_eq!(route(&state, "1").await, None);
    }

    #[tokio::test]
    async fn unreadable_or_shared_owners_are_ambiguous() {
        let state = State::new();
        state.lane("aa", &tern("aa", "1", "w1:p1", "s1"));
        state.lane("bb", &tern("bb", "1", "w1:p2", "s2"));
        assert_eq!(route(&state, "1").await, Some(Route::Ambiguous));
        fs::remove_file(state.0.join("lanes/bb.json")).unwrap();
        state.lane("cc", &tern("cc", "2", "w1:p3", "s1"));
        assert_eq!(
            route(&state, "1").await,
            Some(Route::Ambiguous),
            "same session"
        );
        fs::remove_file(state.0.join("lanes/cc.json")).unwrap();
        state.lane("dd", "{not json");
        assert_eq!(route(&state, "1").await, Some(Route::Ambiguous));
        assert_eq!(
            unique(&state.0, "discord:1")
                .unwrap()
                .map(|l| l.key().to_owned()),
            None
        );
        fs::remove_file(state.0.join("lanes/dd.json")).unwrap();
        state.lane("ee", &tern("zz", "3", "w9:p9", "s9"));
        assert_eq!(
            route(&state, "1").await,
            Some(Route::Ambiguous),
            "miskeyed row"
        );
    }

    #[tokio::test]
    async fn closing_and_paneless_lanes() {
        let state = State::new();
        state.lane(
            "aa",
            &tern("aa", "1", "w1:p1", "s1")
                .replace(r#""title":"""#, r#""nativeCloseIntent":{"at":"x"}"#),
        );
        assert_eq!(route(&state, "1").await, Some(Route::Closing("aa".into())));
        state.lane("aa", &tern("aa", "1", "w1:p1", "s1"));
        assert_eq!(
            route(&state, "1").await,
            Some(Route::Inactive("aa".into())),
            "a tern lane without a pane record is inactive"
        );
    }

    #[tokio::test]
    async fn tern_lanes_route_through_their_pane_record() {
        let state = State::new();
        fs::create_dir_all(state.0.join("sessions")).unwrap();
        let pane = |id: &str| {
            let name = super::super::registry::encode_uri_component(id);
            let body = format!(
                r#"{{"paneId":"{id}","role":"lane","sessionId":"s1","discordLaneInbox":true,"cwd":"/","pid":{},"startedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","goal":{{"status":"active"}},"approvalPending":false}}"#,
                std::process::id()
            );
            fs::write(state.0.join("sessions").join(format!("{name}.json")), body).unwrap();
        };
        pane("w1:p1");
        state.lane("aa", &tern("aa", "1", "w1:p1", "s1"));
        assert_eq!(
            route(&state, "1").await,
            Some(Route::Live {
                key: "aa".into(),
                session: Some("s1".into()),
            }),
            "live tern writer"
        );
    }

    #[tokio::test]
    async fn headless_without_a_receiver_is_native_unavailable() {
        let state = State::new();
        state.lane(
            "aa",
            r#"{"key":"aa","thread":"discord:1","sessionRef":{"runtime":"headless","id":"0b9e7c1a-1111-4222-8333-444455556666"},"session":"s","sessionFile":"/f","cwd":"/","openedAt":"2026-01-01T00:00:00.000Z"}"#,
        );
        assert_eq!(
            route(&state, "1").await,
            Some(Route::NativeUnavailable("aa".into()))
        );
    }

    async fn queue(state: &State, wake: bool) -> Result<Option<String>> {
        let mut seen = None;
        let queued = enqueue(&state.0, "1", wake, Duration::ZERO, |session| {
            seen = Some(session.to_owned());
            Ok(())
        })
        .await?;
        assert_eq!(queued, seen.is_some());
        Ok(seen)
    }

    fn held(result: Result<Option<String>>) -> String {
        result.unwrap_err().downcast::<LaneHold>().unwrap().0
    }

    #[tokio::test]
    async fn enqueue_follows_the_route_and_holds_every_race() {
        let state = State::new();
        assert_eq!(queue(&state, false).await.unwrap(), None);
        state.lane("aa", &tern("aa", "1", "w1:p1", "s1"));
        assert_eq!(
            queue(&state, true).await.unwrap(),
            None,
            "inactive goes to the head"
        );
        let lock = delivery_lock(&state.0, "aa", Duration::ZERO)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            held(queue(&state, false).await),
            "Discord lane delivery is locked; cursor not advanced"
        );
        lock.release().unwrap();
        state.lane(
            "aa",
            &tern("aa", "1", "w1:p1", "s1").replace(r#""title":"""#, r#""nativeCloseIntent":{}"#),
        );
        assert_eq!(
            held(queue(&state, false).await),
            "Discord lane native close is in progress; cursor not advanced"
        );
        state.lane("bb", &tern("bb", "1", "w1:p2", "s2"));
        assert_eq!(
            held(queue(&state, false).await),
            "Discord lane owner ambiguous; cursor not advanced"
        );
        fs::remove_file(state.0.join("lanes/bb.json")).unwrap();
        state.lane(
            "aa",
            r#"{"key":"aa","thread":"discord:1","sessionRef":{"runtime":"headless","id":"0b9e7c1a-1111-4222-8333-444455556666"},"session":"s","openedAt":"x"}"#,
        );
        assert_eq!(
            held(queue(&state, false).await),
            "Discord native lane identity unverified; cursor not advanced"
        );
        state.lane(
            "aa",
            r#"{"key":"aa","thread":"discord:1","sessionRef":{"runtime":"headless","id":"0b9e7c1a-1111-4222-8333-444455556666"},"session":"s","openedAt":"x","lifecycleEpoch":"discord-wake-pending:bound:e"}"#,
        );
        assert_eq!(
            queue(&state, true).await.unwrap().as_deref(),
            Some("s"),
            "bound wake owns it"
        );
        assert!(
            queue(&state, false).await.is_err(),
            "only a wake monitor honors a pending wake"
        );
    }
}

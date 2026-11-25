//! `src/runtime/headless-events.ts`: actionable native UI requests, held apart from the bounded read-only output ring.

use std::collections::VecDeque;

use serde_json::Value;

use super::protocol::{Dialog, Entry, dialog_of, entry_of};
use crate::util;

const RING_SIZE: usize = 40;

#[derive(Debug, Default)]
pub(super) struct Events {
    /// Insertion-ordered like a JS `Map`: replacing an id keeps its position.
    dialogs: Vec<Dialog>,
    recent: VecDeque<Entry>,
    active_since: Option<i64>,
}

impl Events {
    /// `HeadlessEvents.record` for one OMP event frame (responses and readiness never reach it).
    pub(super) fn record(&mut self, frame: &Value) {
        self.record_with(frame, util::now_ms);
    }

    fn record_with(&mut self, frame: &Value, now: impl FnOnce() -> i64) {
        match frame.get("type").and_then(Value::as_str) {
            Some("extension_ui_request") => {
                if frame.get("method").and_then(Value::as_str) == Some("cancel") {
                    if let Some(target) = frame.get("targetId").and_then(Value::as_str) {
                        self.remove_dialog(target);
                    }
                } else if let Some(dialog) = dialog_of(frame) {
                    match self.dialogs.iter_mut().find(|known| known.id == dialog.id) {
                        Some(known) => *known = dialog,
                        None => self.dialogs.push(dialog),
                    }
                }
            }
            Some("agent_start") => {
                if self.active_since.is_none() {
                    self.active_since = Some(now());
                }
            }
            Some("session_settled") => self.active_since = None,
            _ => {}
        }
        if let Some(entry) = entry_of(frame) {
            self.recent.push_back(entry);
            if self.recent.len() > RING_SIZE {
                self.recent.pop_front();
            }
        }
    }

    pub(super) fn dialog(&self, id: &str) -> Option<&Dialog> {
        self.dialogs.iter().find(|dialog| dialog.id == id)
    }

    pub(super) fn remove_dialog(&mut self, id: &str) {
        self.dialogs.retain(|dialog| dialog.id != id);
    }

    pub(super) const fn has_dialogs(&self) -> bool {
        !self.dialogs.is_empty()
    }

    pub(super) fn dialogs(&self) -> &[Dialog] {
        &self.dialogs
    }

    pub(super) fn recent(&self) -> impl Iterator<Item = &Entry> {
        self.recent.iter()
    }

    pub(super) const fn active_since(&self) -> Option<i64> {
        self.active_since
    }

    /// A settled readback ends the active turn (`activeSince = undefined`).
    pub(super) const fn settle(&mut self) {
        self.active_since = None;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::headless::protocol::{DialogKind, answer_frame};

    fn request(id: &str, method: &str) -> Value {
        json!({ "type": "extension_ui_request", "id": id, "method": method, "options": ["Approve Once", "Deny"] })
    }

    fn ids(events: &Events) -> Vec<&str> {
        events
            .dialogs()
            .iter()
            .map(|dialog| dialog.id.as_str())
            .collect()
    }

    // test/runtime-headless.test.ts: one answer per dialog; a second "Deny" finds no matching dialog.
    #[test]
    fn answered_dialogs_are_never_replayed() {
        let mut events = Events::default();
        events.record(&request("p", "select"));
        let dialog = events.dialog("p").expect("pending approval");
        assert!(answer_frame(dialog, &json!({ "value": "Deny" })).is_some());
        events.remove_dialog("p");
        assert!(events.dialog("p").is_none() && !events.has_dialogs());
    }

    #[test]
    fn dialogs_keep_map_order_and_honor_cancellation() {
        let mut events = Events::default();
        events.record(&request("a", "select"));
        events.record(&request("b", "confirm"));
        events.record(&request("a", "editor"));
        assert_eq!(ids(&events), ["a", "b"]);
        assert_eq!(
            events.dialog("a").map(|dialog| dialog.kind),
            Some(DialogKind::Editor)
        );
        events.record(&json!({ "type": "extension_ui_request", "id": "c", "method": "cancel", "targetId": "a" }));
        assert_eq!(ids(&events), ["b"]);
        events
            .record(&json!({ "type": "extension_ui_request", "method": "cancel", "targetId": 1 }));
        events.record(&json!({ "type": "extension_ui_request", "id": "n", "method": "notify", "message": "hi" }));
        events.record(&json!({ "type": "confirm", "id": "x", "method": "confirm" }));
        assert_eq!(ids(&events), ["b"]);
        assert_eq!(events.recent().count(), 1);
    }

    #[test]
    fn the_output_ring_keeps_the_last_40_entries() {
        let mut events = Events::default();
        for n in 0..45 {
            events.record(&json!({ "type": "command_output", "text": format!("line {n}") }));
        }
        let recent: Vec<String> = events
            .recent()
            .map(|entry| {
                serde_json::to_value(entry).unwrap()["text"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(recent.len(), RING_SIZE);
        assert_eq!(
            (recent[0].as_str(), recent[39].as_str()),
            ("line 5", "line 44")
        );
    }

    #[test]
    fn active_since_spans_one_turn() {
        let mut events = Events::default();
        events.record_with(&json!({ "type": "agent_start" }), || 100);
        events.record_with(&json!({ "type": "agent_start" }), || 200);
        assert_eq!(events.active_since(), Some(100));
        events.record_with(&json!({ "type": "session_settled" }), || 300);
        assert_eq!(events.active_since(), None);
        events.record(&json!({ "type": "agent_start" }));
        assert!(
            events
                .active_since()
                .is_some_and(|at| at > 1_700_000_000_000)
        );
        events.settle();
        assert_eq!(events.active_since(), None);
    }
}

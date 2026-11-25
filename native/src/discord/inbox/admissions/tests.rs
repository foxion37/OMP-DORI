use std::os::unix::fs::DirBuilderExt as _;
use std::path::PathBuf;

use serde_json::json;

use super::{Attempt, Inbox, Outcome, Snowflake};
use crate::discord::inbox::Ledger;

fn id(value: u64) -> Snowflake {
    Snowflake::try_from(value.to_string()).unwrap()
}

fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cataly-admissions-{}",
        crate::discord::ipc::random_uuid().unwrap()
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    dir
}

fn attempt<'a>(identity: &'a str, fingerprint: &'a str, source: &'a str) -> Attempt<'a> {
    Attempt {
        identity,
        fingerprint,
        head_file: "/tmp/head.jsonl",
        head_pid: 7,
        source,
    }
}

#[test]
fn a_symlinked_ancestor_opens_but_a_symlinked_queue_directory_does_not() {
    let real = temp();
    let link = real.with_extension("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // macOS's $TMPDIR sits under /var -> /private/var.
    let inbox = Inbox::open(&link.join("queue"), id(1), id(2), Ledger::Forced).unwrap();
    drop(inbox);
    assert!(real.join("queue/gateway.sqlite").is_file());
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(real.join("target"))
        .unwrap();
    std::os::unix::fs::symlink(real.join("target"), real.join("aliased")).unwrap();
    assert!(Inbox::open(&real.join("aliased"), id(1), id(2), Ledger::Forced).is_err());
    std::fs::remove_file(link).unwrap();
    std::fs::remove_dir_all(real).unwrap();
}

#[test]
fn ledger_lifecycle_matches_head_admission_state() {
    let dir = temp();
    let inbox = Inbox::open(&dir, id(1), id(2), Ledger::Forced).unwrap();
    let source = r#"{"channel":"20","message":"101","reference":null,"text":"x","replyTo":null,"attachments":[]}"#;
    let fingerprint = "a".repeat(64);
    assert!(
        inbox
            .admission("1:2:20:101", &fingerprint)
            .unwrap()
            .is_none()
    );
    inbox
        .attempt(&attempt("1:2:20:101", &fingerprint, source))
        .unwrap();
    // A second unresolved attempt, a replay and a fingerprint conflict all fail closed.
    assert!(
        inbox
            .attempt(&attempt("1:2:20:102", &fingerprint, source))
            .is_err()
    );
    assert!(
        inbox
            .attempt(&attempt("1:2:20:101", &fingerprint, source))
            .is_err()
    );
    assert!(inbox.admission("1:2:20:101", &"b".repeat(64)).is_err());
    assert!(inbox.unresolved().unwrap().is_some());
    assert!(inbox.save_cursor(&dir, id(20), id(101)).is_err());
    assert!(inbox.acknowledge(id(20), id(101)).is_err());
    inbox
        .receipt("1:2:20:101", Outcome::Accepted, "entry-1")
        .unwrap();
    inbox
        .receipt("1:2:20:101", Outcome::Accepted, "entry-1")
        .unwrap();
    assert!(
        inbox
            .receipt("1:2:20:101", Outcome::Rejected, "entry-1")
            .is_err()
    );
    assert!(inbox.unresolved().unwrap().is_none());
    inbox.commit_receipts(&dir).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("20.json")).unwrap(),
        "{\"version\":1,\"channelId\":\"20\",\"cursor\":\"101\"}\n"
    );
    // The checkpointed, unqueued native receipt is pruned with its cursor.
    assert!(
        inbox
            .admission("1:2:20:101", &fingerprint)
            .unwrap()
            .is_none()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn queued_receipt_retires_with_its_pending_row() {
    let dir = temp();
    let inbox = Inbox::open(&dir, id(1), id(2), Ledger::Forced).unwrap();
    let raw =
        json!({"id": "101", "channel_id": "20", "type": 0, "author": {"id": "2"}, "content": "x"});
    inbox
        .push_scoped(id(20), id(101), &raw, Some(id(100)), None)
        .unwrap();
    assert!(inbox.has(id(20), id(101)).unwrap());
    let source = r#"{"channel":"20","message":"101"}"#;
    let fingerprint = "c".repeat(64);
    inbox
        .attempt(&attempt("1:2:20:101", &fingerprint, source))
        .unwrap();
    inbox
        .receipt("1:2:20:101", Outcome::Rejected, "entry-2")
        .unwrap();
    inbox.save_cursor(&dir, id(20), id(101)).unwrap();
    // Checkpointed but still queued: retained until the raw ACK fires the retirement trigger.
    assert!(
        inbox
            .admission("1:2:20:101", &fingerprint)
            .unwrap()
            .is_some()
    );
    inbox.acknowledge(id(20), id(101)).unwrap();
    assert!(
        inbox
            .admission("1:2:20:101", &fingerprint)
            .unwrap()
            .is_none()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn duplicate_push_conflicts_only_on_raw_fingerprint_change() {
    let dir = temp();
    let inbox = Inbox::open(&dir, id(1), id(2), Ledger::Forced).unwrap();
    let raw =
        json!({"id": "101", "channel_id": "20", "type": 0, "author": {"id": "2"}, "content": "x"});
    inbox
        .push_scoped(id(20), id(101), &raw, Some(id(100)), None)
        .unwrap();
    let mut refreshed = raw.clone();
    refreshed["edited_timestamp"] = json!("later");
    inbox
        .push_scoped(id(20), id(101), &refreshed, None, Some(id(9)))
        .unwrap();
    let queued = inbox.next_queued(id(20), None).unwrap().unwrap();
    assert_eq!(queued.payload, raw);
    assert_eq!(queued.admitted_after, Some(id(100)));
    assert_eq!(queued.parent, Some(id(9)));
    let mut changed = raw;
    changed["content"] = json!("y");
    assert!(
        inbox
            .push_scoped(id(20), id(101), &changed, None, None)
            .is_err()
    );
    assert!(
        inbox
            .next_queued(id(20), Some((id(101), queued.row)))
            .unwrap()
            .is_none()
    );
    std::fs::remove_dir_all(dir).unwrap();
}

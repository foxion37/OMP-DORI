"""Take over the TypeScript SQLite inbox without replaying its unresolved head attempt."""

import json
from pathlib import Path
import sqlite3
import subprocess

from discord_wire import World, message


def exercise_queue(prefix: list[str], env: dict[str, str], root: Path, world: World, calls: list[str]) -> None:
    inbox = root / "discord-inbound"
    inbox.mkdir(mode=0o700)
    cursor = inbox / "20.json"
    cursor.write_text('{"version":1,"channelId":"20","cursor":"201"}', encoding="utf-8")
    cursor.chmod(0o600)
    transcript = root / "old-head.jsonl"
    transcript.touch(mode=0o600)
    data = {"identity": "99:10:20:203", "fingerprint": "a" * 64}
    path = inbox / "gateway.sqlite"
    path.touch(mode=0o600)
    with sqlite3.connect(path) as db:
        db.executescript("""
          PRAGMA journal_mode=WAL;
          CREATE TABLE pending (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,admitted_after TEXT,thread_parent TEXT);
          CREATE TABLE admissions (identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, head_file TEXT NOT NULL,
            head_pid INTEGER NOT NULL, source TEXT NOT NULL, outcome TEXT NOT NULL, receipt TEXT, reason TEXT,
            attempted_at TEXT NOT NULL, decided_at TEXT, checkpointed INTEGER NOT NULL DEFAULT 0);
        """)
        db.executemany("INSERT INTO pending(kind,payload) VALUES (?,?)", [
            ("sync", "null"), ("message", json.dumps(message("203", "cataly-test: already handled by old head"))),
            ("message", json.dumps(message("204", "cataly-test: retained only in TypeScript SQLite"))),
            ("message", json.dumps(message("205", "cataly-test: never run from another author", user="11"))),
        ])
        db.execute("INSERT INTO admissions(identity,fingerprint,head_file,head_pid,source,outcome,attempted_at) VALUES (?,?,?,?,?,'unresolved','old')",
                   (data["identity"], data["fingerprint"], str(transcript), 1, '{"channel":"20","message":"203"}'))
    db.close()
    argv = [*prefix, "--poll-seconds", "0", "--state-dir", str(root / "queue-cutover"),
            "--inbox", str(inbox), "--import-cursors", str(inbox)]
    world.history.append(message("202", "cataly-test: REST before retained SQLite"))
    blocked = invoke(argv, env)
    assert blocked.returncode != 0 and "HEAD_ADMISSION_UNRESOLVED" in blocked.stderr, blocked
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM pending").fetchone() == (4,)
        assert db.execute("SELECT outcome FROM admissions").fetchone() == ("unresolved",)
    db.close()
    transcript.write_text(json.dumps({"type": "custom_message", "customType": "cataly-monitor", "id": "durable-203",
                                     "details": {"ompCatalyAdmission": data}}) + "\n", encoding="utf-8")
    with sqlite3.connect(path, isolation_level=None) as blocker:
        blocker.execute("PRAGMA locking_mode=EXCLUSIVE")
        blocker.execute("BEGIN EXCLUSIVE")
        concurrent = invoke(argv, env)
        assert concurrent.returncode != 0 and "other receiver" in concurrent.stderr, concurrent
        blocker.rollback()
    blocker.close()
    for _ in range(2):
        result = invoke(argv, env)
        assert result.returncode == 0 and "mode=rust-rest" in result.stdout, result
    assert [world.replies.get(timeout=5)["message_reference"]["message_id"] for _ in range(2)] == ["202", "204"]
    assert world.replies.empty()
    assert calls.count("retained only in TypeScript SQLite") == 1
    assert "already handled by old head" not in calls and "never run from another author" not in calls
    assert json.loads(cursor.read_text(encoding="utf-8"))["cursor"] == "205"
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM pending").fetchone() == (0,)
        assert db.execute("SELECT outcome,receipt FROM admissions").fetchone() == ("accepted", "durable-203")
    db.close()
    # Other exercises reuse this wire fixture; restore its original history boundary.
    world.history[:] = [item for item in world.history if item["id"] != "202"]


def invoke(argv: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, env=env, text=True, capture_output=True, check=False, timeout=30)

"""Rust-owned Discord head against the same stock OMP harness used by normal lane tests."""

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from queue import Empty
from select import select
import subprocess
from threading import Thread

from discord_wire import Discord, World, message


def exercise_head(command: list[str], env: dict[str, str], root: Path, model, run_harness) -> None:
    world = World()
    with ThreadingHTTPServer(("127.0.0.1", 0), Discord) as server:
        server.world = world
        serving = Thread(target=server.serve_forever, daemon=True)
        serving.start()
        port = server.server_port
        wire = {**env, "CATALY_DISCORD_TOKEN": "synthetic-discord-token", "CATALY_DISCORD_OWNER_ID": "10",
                "CATALY_DISCORD_API_BASE": f"http://127.0.0.1:{port}/api/v10/",
                "CATALY_DISCORD_GATEWAY_URL": f"ws://127.0.0.1:{port}/gateway"}
        try:
            route_head(command, wire, root, model, run_harness, world)
        finally:
            server.shutdown()
            serving.join()


def route_head(command, env, root, model, run_harness, world: World) -> None:
    store = root / "discord-head"
    harness = [*command[:8], "--state-dir", str(store)]
    opened, closed = run_harness(harness, env, {"op": "open", "key": "head"}, {"op": "close", "key": "head"})
    assert opened["state"] == "open" and closed["state"] == "closed", (opened, closed)
    bound = closed["binding"]["session"]
    ask = root / "discord-ask-replies"
    ask.mkdir(mode=0o700)
    question = ask / "20-95"
    question.mkdir(mode=0o700)
    (question / "owner").write_text("10", encoding="utf-8")
    (question / "owner").chmod(0o600)
    argv = [*command[:7], "discord", "--channel", "20", "--channel", "22",
            "--state-dir", str(store), "--ask-state", str(root)]
    head = [*argv, "--head-channel", "20"]
    once = [*head, "--poll-seconds", "0"]
    run_monitor(once, env)
    world.history.extend([
        {**message("101", "answer for the existing ASK"), "type": 19, "message_reference": {"message_id": "95"}},
        message("102", "cataly-test: native head first"),
    ])
    run_monitor(once, env)
    assert json.loads((question / "reply-101").read_text(encoding="utf-8")) == "answer for the existing ASK"
    assert world.replies.get(timeout=5)["message_reference"]["message_id"] == "102"

    world.history.append(message("103", "cataly-test: native head after restart"))
    run_monitor(once, env)
    assert world.replies.get(timeout=5)["content"] == "확인: native head after restart"
    parked, first, second = run_harness(harness, env, {"op": "status", "key": "head"},
        {"op": "receipt", "id": "discord-102"}, {"op": "receipt", "id": "discord-103"})
    assert parked["state"] == "parked" and parked["binding"]["session"] == bound, parked
    assert all(row["claim"]["lane"] == "head" and row["claim"]["session_id"] == bound["id"] for row in (first, second))
    assert "answer for the existing ASK" not in model.calls and model.calls.count("native head first") == 1
    world.history.append(message("106", "cataly-test: independent conversation", channel="22"))
    run_monitor(once, env)
    assert world.replies.get(timeout=5)["message_reference"]["channel_id"] == "22"
    lane, = run_harness(harness, env, {"op": "receipt", "id": "discord-106"})
    assert lane["claim"]["session_id"] != bound["id"] and lane["claim"]["lane"] != "head", lane
    rejected = subprocess.run([*argv, "--poll-seconds", "0"], env=env, capture_output=True, text=True, check=False, timeout=15)
    assert rejected.returncode != 0 and "bound to a different" in rejected.stderr, rejected
    assert world.replies.empty()
    hold_head(head, env, harness, model, run_harness, world)


def hold_head(head, env, harness, model, run_harness, world: World) -> None:
    # Supply work only after the baseline and connection are established.
    model.controlled_started.clear()
    model.controlled_release.clear()
    while not world.typings.empty():
        try:
            world.typings.get_nowait()
        except Empty:
            break
    prior = model.calls.count("controlled interruption")
    with subprocess.Popen([*head, "--gateway"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as worker:
        try:
            assert select([worker.stdout], [], [], 10)[0]
            assert b"mode=rust-gateway" in worker.stdout.readline()
            assert world.ready.wait(5)
            contender = subprocess.run(harness, env=env, input="", capture_output=True, text=True,
                                       check=False, timeout=15)
            assert contender.returncode != 0 and "already controlled" in contender.stderr, contender
            world.add(message("104", "cataly-test: controlled interruption"))
            assert model.controlled_started.wait(15)
            assert world.typings.get(timeout=5) == "20"
            assert world.typings.get(timeout=10) == "20"
        finally:
            worker.terminate()
            output, error = worker.communicate(timeout=20)
            model.controlled_release.set()
    assert worker.returncode == 0, (output, error)
    world.history.append(message("105", "cataly-test: must stay outside the held head"))
    restarted = subprocess.run([*head, "--poll-seconds", "0"], env=env, capture_output=True, text=True,
                               check=False, timeout=20)
    assert restarted.returncode != 0 and "unconfirmed request discord-104" in restarted.stderr, restarted
    held, blocked = run_harness(harness, env, {"op": "receipt", "id": "discord-104"}, {"op": "receipt", "id": "discord-105"})
    assert held["status"] == "unconfirmed" and "unknown Cataly request" in blocked["error"], (held, blocked)
    assert model.calls.count("controlled interruption") == prior + 1
    assert "must stay outside the held head" not in model.calls


def run_monitor(argv: list[str], env: dict[str, str]) -> None:
    result = subprocess.run(argv, env=env, capture_output=True, text=True, check=False, timeout=25)
    assert result.returncode == 0 and "mode=rust-rest" in result.stdout, result

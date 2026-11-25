"""Exercise the real Discord CLI, HTTPS/WS client and OMP against loopback only."""

from http.server import ThreadingHTTPServer
from pathlib import Path
from queue import Empty
from select import select
import subprocess
from threading import Thread

from discord_wire import Discord, World, message
from stock_discord_send import exercise_send
from stock_discord_queue import exercise_queue


README = "Cataly transport fixture — 네이티브 Discord"


def exercise_monitor(command, env, root, calls, results):
    world = World()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Discord)
    server.world = world
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_port
    wire_env = {
        **env, "CATALY_DISCORD_TOKEN": "synthetic-discord-token", "CATALY_DISCORD_OWNER_ID": "10",
        "CATALY_DISCORD_API_BASE": f"http://127.0.0.1:{port}/api/v10/",
        "CATALY_DISCORD_GATEWAY_URL": f"ws://127.0.0.1:{port}/gateway",
    }
    prefix = [*command[:7], "discord", "--channel", "20"]
    try:
        rest(prefix, wire_env, root, world, calls, command[2])
        gateway(prefix, wire_env, root, world, calls, results)
        memory_checkpoint(prefix, wire_env, root, world)
        exercise_queue(prefix, wire_env, root, world, calls)
        exercise_send(command[0], wire_env, world)
        presence(command[0], wire_env, world)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def presence(binary, env, world):
    online = {"since": None, "activities": [], "status": "online", "afk": False}
    world.heartbeat.clear()
    with subprocess.Popen(
        [binary, "--omp", "/no-omp-needed-for-presence", "discord-presence"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as child:
        try:
            identify = world.auth.get(timeout=5)
            assert identify["op"] == 2 and identify["d"]["presence"] == online, identify
            assert identify["d"]["intents"] == 1 << 9
            assert world.heartbeat.wait(5)
            world.events.put({"op": 7})
            resumed = world.auth.get(timeout=12)
            assert resumed["op"] == 6 and resumed["d"]["session_id"] == "local-session", resumed
            assert world.presence.get(timeout=5) == online
            child.terminate()
            out, err = child.communicate(timeout=8)
            assert child.returncode == 0, (out, err)
            for line in (b"PRESENCE_READY discord event=READY", b"PRESENCE_ACK discord",
                         b"PRESENCE_READY discord event=RESUMED", b"PRESENCE_STOPPED discord"):
                assert line in out, (out, err)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)


def memory_checkpoint(prefix, env, root, world):
    recorder = Path(env["HOME"]) / ".local" / "bin" / "ai-memory"
    recorder.parent.mkdir(parents=True, mode=0o700)
    (Path(env["HOME"]) / ".local" / "share" / "ai-memory").mkdir(parents=True, mode=0o700)
    recorder.write_text("""#!/bin/sh
set -eu
[ -z "${CATALY_DISCORD_TOKEN:-}" ]
[ "$AI_MEMORY_SERVER_URL" = http://127.0.0.1:49374 ]
printf '%s\\n' "$*" >> "$HOME/checkpoint-args"
/bin/cat >> "$HOME/checkpoint-body"
""", encoding="utf-8")
    recorder.chmod(0o700)
    state = root / "discord-memory"
    world.history[:] = [
        message("107", "!remember person quiet private note"),
        message("108", "!remember project verified project note"),
        message("109", "!remember common password exclude-this"),
    ]
    cursors = root / "ts-discord"
    argv = [*prefix, "--poll-seconds", "0", "--state-dir", str(state), "--import-cursors", str(cursors)]
    unavailable = root / "omp-must-not-start-for-memory"
    unavailable.write_text("#!/bin/sh\nexit 86\n", encoding="utf-8")
    unavailable.chmod(0o700)
    argv[2] = str(unavailable)
    for _ in range(2):
        completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=55, check=False)
        assert completed.returncode == 0 and "CATALY_MEMORY_EXPORT_HELD" not in completed.stderr, completed
    replies = [world.replies.get(timeout=5)["content"] for _ in range(3)]
    assert replies[:2] == ["Saved to local Cataly memory."] * 2 and replies[2].startswith("No note saved."), replies
    args = (Path(env["HOME"]) / "checkpoint-args").read_text(encoding="utf-8").splitlines()
    body = (Path(env["HOME"]) / "checkpoint-body").read_text(encoding="utf-8")
    assert len(args) == 4 and any("--path notes/107.md" in value and "--project person-" in value for value in args), args
    assert any("--path notes/108.md" in value and "--project project-" in value for value in args), args
    assert "quiet private note" in body and "verified project note" in body and "exclude-this" not in body, body


def rest(prefix, env, root, world, calls, omp):
    cursors = root / "ts-discord"
    cursors.mkdir(mode=0o700)
    cursor = cursors / "20.json"
    cursor.write_text('{"version":1,"channelId":"20","cursor":"100"}', encoding="utf-8")
    cursor.chmod(0o600)
    wrapper = root / "omp-new-version"
    wrapper.write_text(f"""#!/bin/sh
case "$1" in --version) exit 1;; esac
[ -z "$CATALY_DISCORD_TOKEN" ] || exit 71
exec "{omp}" "$@"
""", encoding="utf-8")
    wrapper.chmod(0o700)
    prefix = [*prefix]
    prefix[2] = str(wrapper)
    argv = [*prefix, "--poll-seconds", "0", "--state-dir", str(root / "discord-transport"),
            "--import-cursors", str(cursors)]
    world.rate_limit = True
    world.history.extend([
        message("101", "cataly-test: ignored nonowner", "11"),
        message("102", "cataly-test: native ordinary REST"),
    ])
    for _ in range(2):
        completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30, check=False)
        assert completed.returncode == 0 and "mode=rust-rest" in completed.stdout, completed
    reply = world.replies.get(timeout=5)
    assert reply["content"] == "확인: native ordinary REST", reply
    assert reply["message_reference"]["message_id"] == "102" and reply["enforce_nonce"] is True
    assert len(world.nonces) == 2 and world.nonces[0] == world.nonces[1], world.nonces
    assert "ignored nonowner" not in calls and "old history" not in calls
    assert calls.count("native ordinary REST") == 1 and world.replies.empty()


def gateway(prefix, env, root, world, calls, results):
    argv = [*prefix, "--gateway", "--state-dir", str(root / "discord-transport")]
    (root / "project" / "README.md").unlink(missing_ok=True)
    (root / "project" / "README.md").write_text(README, encoding="utf-8")
    with subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        try:
            assert select([child.stdout], [], [], 18)[0], "no Rust Discord startup line"
            assert b"mode=rust-gateway" in child.stdout.readline(), child.communicate(timeout=5)
            assert world.auth.get(timeout=5)["op"] == 2
            assert world.ready.wait(5) and world.heartbeat.wait(5)
            measure_idle(child.pid)
            world.events.put({"op": 7})
            resume = world.auth.get(timeout=5)
            assert resume["op"] == 6 and resume["d"]["session_id"] == "local-session", resume
            world.dispatch("MESSAGE_CREATE", message("103", "cataly-test: native ordinary Gateway"))
            plain = world.replies.get(timeout=15)
            assert plain["content"] == "확인: native ordinary Gateway" and "components" not in plain, plain
            assert calls.count("native ordinary Gateway") == 1
            for case, request in (("approve", "104"), ("deny", "105")):
                exercise_card(world, results, case, request)
            world.add(message("106", "!cataly cataly-test: workspace tool fixture"))
            offered = world.replies.get(timeout=15)
            assert offered["message_reference"]["message_id"] == "106" and offered["components"]
            before = len(results)
            child.terminate()
            stdout, stderr = child.communicate(timeout=18)
            assert child.returncode == 0, (stdout, stderr)
            assert world.cleared.get(timeout=3) == {"components": []}
            assert world.replies.empty() and len(results) == before
            assert b"synthetic-discord-token" not in stdout + stderr
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=6)


def exercise_card(world, results, choice, request):
    world.add(message(request, "!cataly cataly-test: workspace tool fixture"))
    offered = world.replies.get(timeout=15)
    assert offered["message_reference"]["message_id"] == request, offered
    buttons = offered["components"][0]["components"]
    custom_id = next(button["custom_id"] for button in buttons if button["custom_id"].endswith(":" + choice))
    before = len(results)
    first = int(request) * 100
    world.click(str(first), custom_id, user="11")
    world.click(str(first + 1), custom_id, card="301")
    world.click(str(first + 2), "cataly-readme:stale:approve")
    for ident in range(first, first + 3):
        observed_id, callback = world.callbacks.get(timeout=5)
        assert observed_id == str(ident) and callback["type"] == 4 and callback["data"]["flags"] == 64
    assert len(results) == before
    world.click(str(first + 3), custom_id)
    observed_id, callback = world.callbacks.get(timeout=5)
    assert observed_id == str(first + 3) and callback == {"type": 7, "data": {"components": []}}
    reply = world.replies.get(timeout=15)
    expected = README if choice == "approve" else "The user denied the README.md request"
    assert expected in reply["content"] and reply["message_reference"]["message_id"] == request, reply
    assert len(results) == before + 1 and expected in results[-1]
    if choice == "deny":
        assert README not in results[-1]


def measure_idle(pid):
    process = Path(f"/proc/{pid}")
    status = process / "status"
    if status.is_file():
        children = process / "task" / str(pid) / "children"
        assert children.read_text().strip() == "", "OMP remains resident while Discord is idle"
        rss = next(line.strip() for line in status.read_text().splitlines() if line.startswith("VmRSS:"))
        print(f"Native Discord idle: {rss}, OMP children=0", flush=True)

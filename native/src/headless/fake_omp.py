#!/usr/bin/env python3
"""A fake OMP speaking pinned rpc-ui v1 for the headless host tests (modeled on test/fixtures/headless-rpc.ts)."""

import json
import os
import sys
import time
import uuid

argv = sys.argv[1:]
if "--version" in argv:
    print(os.environ["FAKE_OMP_VERSION"])
    sys.exit(0)
if "rpc-ui" not in argv or "always-ask" not in argv:
    sys.exit("not the isolated native headless launch")

saved = os.environ["CATALY_TEST_SESSION"]
trace = os.environ["CATALY_TEST_TRACE"]
role = "lane" if "lane" in argv else "cataly"
session = str(uuid.uuid4())
with open(saved, "w", encoding="utf-8") as file:
    file.write(json.dumps({"type": "session", "id": session}) + "\n")


def log(text):
    with open(trace, "a", encoding="utf-8") as file:
        file.write(text)


names = ("CATALY_HEADLESS_ID", "PI_NOTIFICATIONS", "CATALY_HARNESS_ROLE")
log(json.dumps({"pid": os.getpid(), "argv": argv, "cwd": os.getcwd(), "env": {k: os.environ.get(k) for k in names}}) + "\n")


def send(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


# FAKE_SCENARIO: "unproven-dialog" raises an approval before the role proof, which then fails.
# The prompt "deaf" makes the fake stop reading stdin right after answering the next get_state.
scenario = os.environ.get("FAKE_SCENARIO", "")
working = False
deaf = False
goal = None
prompt = None
model = {"provider": "fixture", "id": "initial"}
send({"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2]})
for line in sys.stdin:
    log(line)
    frame = json.loads(line)
    kind = frame.get("type")

    def ack(data=None):
        reply = {"id": frame.get("id"), "type": "response", "command": kind, "success": True}
        if data is not None:
            reply["data"] = data
        send(reply)

    if kind == "get_state":
        ack({"sessionId": session, "sessionFile": saved, "isSettled": not working, "isStreaming": working,
             "goal": {"goal": goal} if goal else None, "model": model})
        if deaf:
            time.sleep(3600)
    elif kind == "get_entries":
        proven = "cataly" if scenario == "unproven-dialog" else role
        entries = [{"type": "custom", "customType": "omp-cataly:role", "data": proven}]
        harness = os.environ.get("CATALY_HARNESS_ROLE")
        if harness:
            entries.append({"type": "custom", "customType": "omp-cataly:harness-role",
                            "data": {"role": harness, "refId": os.environ["CATALY_HEADLESS_ID"]}})
        ack({"entries": entries})
    elif kind == "goal":
        if frame.get("op") == "create":
            goal = {"status": "active", "objective": frame.get("objective")}
        elif frame.get("op") == "pause" and goal:
            goal["status"] = "paused"
        elif frame.get("op") == "resume" and goal:
            goal["status"] = "active"
        ack({"goal": goal})
    elif kind == "abort":
        working = False
        send({"type": "session_settled"})
        ack()
    elif kind == "set_ask_dialog":
        ack({"enabled": True})
        if scenario == "unproven-dialog":
            send({"type": "extension_ui_request", "id": "early", "method": "select",
                  "title": "Approve before proof?", "options": ["Approve Once", "Deny"]})
    elif kind == "set_model":
        model = {"provider": frame["provider"], "id": frame["modelId"]}
        ack(model)
    elif kind in ("prompt", "follow_up", "steer"):
        message = frame["message"]
        ack()
        if message == "long turn":
            working = True
            send({"type": "agent_start"})
        elif message == "request approval":
            working = True
            send({"type": "agent_start"})
            prompt = str(uuid.uuid4())
            send({"type": "extension_ui_request", "id": prompt, "method": "select",
                  "title": "Approve this fake write?", "options": ["Approve Once", "Approve for this session", "Deny"]})
        elif message == "deaf":
            deaf = True
        elif message == "surrogates":
            # json.dumps escapes these as \ud83d and \udc00 (unpaired) and \ud83d\ude00 (a pair).
            text = "a\ud83d b\udc00 c\U0001F600"
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
        else:
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": message}]}})
    elif kind == "extension_ui_response" and frame.get("id") == prompt:
        prompt = None
        working = False
        send({"type": "session_settled"})

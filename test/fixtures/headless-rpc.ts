import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) {
  console.log(
    process.env["CATALY_TEST_OMP_VERSION"] ??
      JSON.parse(readFileSync(new URL("../../native-omp.lock", import.meta.url), "utf8")).nativeVersion,
  );
  process.exit(0);
}
if (
  !process.argv.includes("rpc-ui") ||
  !process.argv.includes("always-ask") ||
  process.env["CATALY_ASK_LAUNCHED_LANE"] !== undefined
)
  throw new Error("not the isolated native headless launch");

const saved = process.env["CATALY_TEST_SESSION"]!;
const trace = process.env["CATALY_TEST_TRACE"]!;
const resume = process.argv.find((arg) => arg.startsWith("--resume="));
const id = resume ? (JSON.parse(readFileSync(saved, "utf8").split("\n", 1)[0]!) as { id: string }).id : randomUUID();
if (!resume) writeFileSync(saved, `${JSON.stringify({ type: "session", id, cwd: process.cwd() })}\n`);
const role = process.argv.includes("lane") ? "lane" : "cataly";
const send = (data: object) => process.stdout.write(`${JSON.stringify(data)}\n`);
const scenario = process.env["CATALY_TEST_MODEL_ATTESTATION"];
const requested = /^--cataly-launch-model=([^/]+)\/(.+)$/.exec(
  process.argv.find((arg) => arg.startsWith("--cataly-launch-model=")) ?? "",
);
const initial = { provider: "fixture", id: "initial" };
const fallback = { provider: "other", id: "initial" };
let working = false;
let background = false;
let model = scenario === "mismatch" ? fallback : initial;
const launchEntry =
  requested && scenario !== "missing"
    ? {
        type: "custom",
        customType: "omp-cataly:headless-launch-model",
        data: {
          refId: scenario === "foreign" ? "different-host" : process.env["CATALY_HEADLESS_ID"],
          sessionId: scenario === "foreign-session" ? "other-session" : id,
          proof: {
            requested: { provider: requested[1], id: requested[2] },
            observed: model,
            status: scenario === "mismatch" || scenario === "unavailable" || scenario === "unknown" ? scenario : "matched",
            billing: "non-subscription",
            checkedAt: scenario === "stale" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString(),
            source: "native-extension",
            ...(process.env["CATALY_TEST_MODEL_THINKING"]
              ? { thinking: JSON.parse(process.env["CATALY_TEST_MODEL_THINKING"]) as unknown }
              : {}),
          },
        },
      }
    : undefined;
let goal: { status: string; objective: string } | null = resume ? { status: "paused", objective: "restored" } : null;
let prompt: string | null = null;
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line) as Record<string, unknown>;
  appendFileSync(trace, `${line}\n`);
  const type = frame["type"];
  const ack = (data?: object) => send({ id: frame["id"], type: "response", command: type, success: true, data });
  if (type === "get_state") {
    const done = process.env["CATALY_TEST_BACKGROUND_DONE"];
    if (done && existsSync(done)) background = false;
    ack({ sessionId: id, sessionFile: saved, isSettled: !working && !background, isStreaming: working,
      goal: goal ? { goal } : null, model });
  } else if (type === "get_entries") {
    const harnessRole = process.env["CATALY_HARNESS_ROLE"];
    const entries: object[] = [{ type: "custom", customType: "omp-cataly:role", data: role }];
    if (harnessRole) {
      entries.push({
        type: "custom",
        customType: "omp-cataly:harness-role",
        data: { role: harnessRole, refId: process.env["CATALY_HEADLESS_ID"] },
      });
    }
    if (launchEntry) entries.push(launchEntry);
    ack({ entries });
    if (scenario === "changed") model = { provider: initial.provider, id: "Initial" };
  } else if (type === "goal") {
    if (frame["op"] === "create") goal = { status: "active", objective: String(frame["objective"]) };
    if (frame["op"] === "pause" && goal) goal.status = "paused";
    if (frame["op"] === "resume" && goal) goal.status = "active";
    ack({ goal });
  } else if (type === "abort") {
    working = false;
    send({ type: "session_settled" });
    ack();
  } else if (type === "set_ask_dialog") {
    ack({ enabled: true });
  } else if (type === "set_model") {
    model = { provider: String(frame["provider"]), id: String(frame["modelId"]) };
    ack(model);
  } else if (type === "prompt" || type === "follow_up" || type === "steer") {
    const message = String(frame["message"]);
    if (message.startsWith("slow admission")) await Bun.sleep(300);
    ack();
    if (message === "long turn") {
      working = true;
      send({ type: "agent_start" });
    } else if (message === "background job") {
      background = true;
    } else if (message === "request approval" || message === "request question") {
      working = true;
      send({ type: "agent_start" });
      prompt = randomUUID();
      send(message === "request approval"
        ? {
            type: "extension_ui_request",
            id: prompt,
            method: "select",
            title: "Approve this fake write?",
            options: ["Approve Once", "Approve for this session", "Deny"],
          }
        : {
            type: "extension_ui_request",
            id: prompt,
            method: "ask",
            questions: [{ id: "single", question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
          });
    } else {
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: message }] } });
    }
  } else if (type === "extension_ui_response" && frame["id"] === prompt) {
    prompt = null;
    working = false;
    send({ type: "session_settled" });
  }
}

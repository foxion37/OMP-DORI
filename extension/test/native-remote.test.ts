import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { remoteSocketDir, remoteSocketPath } from "../../src/remote/socket-path.ts";
import ompCataly from "../index.ts";
import { DUTY_INVARIANTS, ROLE_INVARIANTS } from "../role-invariants.ts";
import { fakePi, type FakePi, useConfig } from "./fake-pi.ts";

type Reply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
const roots: string[] = [];
const active: FakePi[] = [];
const names = ["CATALY_HEADLESS_ID", "CATALY_HARNESS_ROLE", "CATALY_CONFIG", "CATALY_STATE_DIR"] as const;
const env = new Map<string, string | undefined>();
const unixSocketTest = test.skipIf(typeof process.getuid !== "function");

beforeEach(() => {
  for (const name of names) {
    env.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const fake of active.splice(0)) await fake.emit("session_shutdown");
  for (const root of roots.splice(0)) {
    if (typeof process.getuid === "function") rmSync(remoteSocketDir(root), { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  }
  for (const [name, value] of env) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  env.clear();
});

function request(path: string, json: Record<string, unknown> | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.on("error", reject);
    socket.setTimeout(2000, () => socket.destroy(new Error("test request timed out")));
    socket.on("connect", () => socket.end(typeof json === "string" ? json : `${JSON.stringify(json)}\n`));
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response) as Reply);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function data(reply: Reply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

async function fixture(options?: { role?: "cataly" | "lane"; mode?: string; sub?: boolean; plain?: boolean }) {
  const root = useConfig();
  roots.push(root);
  const session = randomUUID();
  const fake = fakePi({
    session: { id: session, file: `${root}/native/${session}.jsonl`, entries: [] },
    flags: options?.plain ? {} : { "cataly-role": options?.role ?? "cataly" },
    mode: options?.mode ?? "tui",
    agent: options?.sub ? { kind: "sub", id: "Child", parentId: "Main" } : undefined,
  });
  const state = { idle: true, pending: false, job: false, aborts: 0, closes: 0 };
  let nativeModel = { provider: "fixture", id: "one" };
  const original = fake.ctx;
  fake.ctx = () => ({
    ...original(),
    hasUI: options?.mode === "rpc",
    get model() {
      return nativeModel;
    },
    models: {
      current: () => nativeModel,
      resolve: (selector) =>
        selector === "fixture/one" || selector === "fixture/two"
          ? { provider: "fixture", id: selector.slice("fixture/".length) }
          : undefined,
    },
    abort: () => void state.aborts++,
    shutdown: () => void state.closes++,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    getAsyncJobSnapshot: () => ({
      running: state.job ? [{ id: "busy", startTime: 1, status: "running" as const, type: "bash", label: "busy" }] : [],
      recent: [],
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    }),
  });
  fake.api.setModel = async (model) => {
    nativeModel = { provider: model.provider ?? "", id: model.id };
    return true;
  };
  active.push(fake);
  await ompCataly(fake.api);
  const path = remoteSocketPath(root, session);
  const info = async (at = path) => data(await request(at, { op: "info" }));
  const bound = async () => {
    const { generation } = await info();
    return (op: string, fields: Record<string, unknown> = {}) => request(path, { session, generation, op, ...fields });
  };
  return { fake, root, path, session, info, bound, state };
}

test("native role and monitor work without Unix user ownership", async () => {
  const root = useConfig();
  roots.push(root);
  const fake = fakePi({ session: { id: randomUUID(), entries: [] }, flags: { "cataly-role": "cataly" } });
  active.push(fake);
  const original = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
  try {
    await ompCataly(fake.api);
    await fake.emit("session_start");
    expect(fake.session.entries).toContainEqual({ type: "custom", customType: "omp-cataly:role", data: "cataly" });
    expect(fake.active).toContain("monitor");
    expect(fake.notes.join("\n")).not.toContain("Native remote");
  } finally {
    if (original) Object.defineProperty(process, "getuid", original);
    else Reflect.deleteProperty(process, "getuid");
  }
});

test("a native duty transcript does not acquire the lead monitor", async () => {
  const root = useConfig();
  roots.push(root);
  process.env.CATALY_HARNESS_ROLE = "duty";
  const fake = fakePi({
    session: { id: randomUUID(), entries: [] },
    flags: { "cataly-role": "cataly" },
    mode: "rpc",
    hasUI: true,
  });
  active.push(fake);
  await ompCataly(fake.api);
  await fake.emit("session_start");
  expect(fake.active).not.toContain("monitor");
  expect(fake.session.entries).toEqual([{ type: "custom", customType: "omp-cataly:role", data: "cataly" }]);
});

test.each([
  { role: "duty", refId: randomUUID() },
  { role: "lead", refId: "not-a-native-ref" },
])("flagless archived duty or malformed newest proof cannot acquire lead capabilities %#", async (proof) => {
  const root = useConfig();
  roots.push(root);
  const fake = fakePi({
    mode: "tui",
    session: {
      id: randomUUID(),
      entries: [
        { type: "custom", customType: "omp-cataly:role", data: "cataly" },
        {
          type: "custom",
          customType: "omp-cataly:harness-role",
          data: { role: "lead", refId: randomUUID() },
        },
        { type: "custom", customType: "omp-cataly:harness-role", data: proof },
        {
          type: "custom",
          customType: "omp-cataly:monitor",
          data: { op: "start", name: "lead-intake", argv: [join(root, "missing-monitor")], filter: ".", cwd: root },
        },
      ],
    },
  });
  active.push(fake);
  await ompCataly(fake.api);
  await fake.emit("session_start");
  expect(fake.active).not.toContain("monitor");
  expect(fake.messages).toEqual([]);
  expect(await fake.emit("before_agent_start", { systemPrompt: ["base"] })).toContainEqual({
    systemPrompt: ["base", DUTY_INVARIANTS],
  });

  fake.session = { id: randomUUID(), entries: [] };
  await fake.emit("session_switch", { reason: "new" });
  expect(fake.session.entries).toEqual([]);
  expect(fake.active).not.toContain("monitor");

  // Explicitly resuming a different lead still uses the lead scope; the duty record is branch-local.
  fake.session = {
    id: randomUUID(),
    entries: [{ type: "custom", customType: "omp-cataly:role", data: "cataly" }],
  };
  await fake.emit("session_switch", { reason: "resume" });
  expect(fake.active).toContain("monitor");
  expect(await fake.emit("before_agent_start", { systemPrompt: ["base"] })).toContainEqual({
    systemPrompt: ["base", ROLE_INVARIANTS.cataly],
  });
});

unixSocketTest("private socket is exact, bounded, and only publishes native Cataly roots", async () => {
  const { fake, root, path, session, info, bound } = await fixture();
  await fake.emit("session_start");
  expect(lstatSync(remoteSocketDir(root)).mode & 0o7777).toBe(0o700);
  expect(lstatSync(path).mode & 0o7777).toBe(0o600);
  expect(await info()).toMatchObject({
    session,
    role: "cataly",
    model: "fixture/one",
    status: "idle",
    pid: process.pid,
  });
  const ask = await bound();
  expect(await ask("exec", { text: "id" })).toMatchObject({ ok: false });
  expect(await ask("read", { session: "different" })).toMatchObject({ ok: false });
  expect(await request(path, `${"a".repeat(70 * 1024)}\n`)).toMatchObject({ ok: false });
  await fake.emit("session_shutdown");
  await expect(request(path, { op: "info" })).rejects.toThrow();
  expect(existsSync(path)).toBe(false);

  for (const options of [{ plain: true }, { sub: true }, { mode: "print" }, { mode: "rpc", role: "lane" as const }]) {
    const excluded = await fixture(options);
    await excluded.fake.emit("session_start");
    expect(existsSync(excluded.path)).toBe(false);
  }
  const headless = randomUUID();
  process.env.CATALY_HEADLESS_ID = headless;
  const lane = await fixture({ mode: "rpc", role: "lane" });
  await lane.fake.emit("session_start");
  expect(await lane.info()).toMatchObject({ role: "lane", pane: `headless:${headless}` });
});

unixSocketTest("socket startup never alters an unsafe directory or a symlink", async () => {
  for (const symlink of [false, true]) {
    const { fake, root, path } = await fixture();
    const dir = remoteSocketDir(root);
    if (symlink) symlinkSync(dirname(root), dir);
    else mkdirSync(dir, { mode: 0o755 });
    await fake.emit("session_start");
    expect(fake.notes.join("\n")).toContain("Unsafe native remote socket directory");
    expect(lstatSync(dir).isSymbolicLink()).toBe(symlink);
    expect(existsSync(path)).toBe(false);
  }
  const { fake, root, path } = await fixture();
  const target = `${dirname(root)}/unrelated`;
  mkdirSync(remoteSocketDir(root), { mode: 0o700 });
  writeFileSync(target, "must stay");
  symlinkSync(target, path);
  await fake.emit("session_start");
  expect(fake.notes.join("\n")).toContain("Unsafe native remote socket");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(existsSync(target)).toBe(true);
});

unixSocketTest("an existing exact socket owner cannot be replaced by another root", async () => {
  const { fake, session, info } = await fixture();
  await fake.emit("session_start");
  const first = await info();
  const second = fakePi({
    session: { id: session, entries: [] },
    flags: { "cataly-role": "lane" },
    mode: "tui",
  });
  active.push(second);
  await ompCataly(second.api);
  await second.emit("session_start");
  expect(second.notes.join("\n")).toContain("already has a live owner");
  expect(await info()).toEqual(first);
  await fake.emit("session_shutdown");
  await second.emit("session_start");
  expect(await info()).toMatchObject({ role: "lane" });
  expect((await info()).generation).not.toBe(first.generation);
});

unixSocketTest("native send preserves input and exposes idempotent receipts, not a guessed reply", async () => {
  const { fake, bound, session, state } = await fixture();
  const pending = Promise.withResolvers<void>();
  const calls: { text: string; options: unknown }[] = [];
  fake.api.sendUserMessage = (text, options) => {
    calls.push({ text, options });
    return pending.promise;
  };
  await fake.emit("session_start");
  const ask = await bound();
  expect(data(await ask("receipt", { id: "unknown" }))).toEqual({ id: "unknown", status: "not-found" });
  const input = { id: "first", text: "  exact native prompt\n" };
  expect(data(await ask("send", input))).toEqual({ id: input.id, status: "pending" });
  expect(data(await ask("send", input))).toEqual({ id: input.id, status: "pending" });
  expect(await ask("send", { ...input, text: "different" })).toMatchObject({ ok: false });
  expect(calls).toEqual([{ text: input.text, options: { deliverAs: "aside" } }]);
  // An unrelated transcript entry with the exact same text is not admission.
  await fake.emit("message_end", { message: { role: "user", content: input.text } });
  expect(data(await ask("receipt", { id: "first" })).status).toBe("pending");
  expect(await fake.emit("session_before_switch")).toContainEqual({ cancel: true });
  pending.resolve();
  expect(data(await ask("receipt", { id: "first" }))).toEqual({
    id: "first",
    status: "admitted",
    receipt: { id: "first", kind: "native-submission" },
    replyAttributed: false,
  });
  await fake.emit("tool_approval_requested", { toolCallId: "foreign", sessionId: "different" });
  state.idle = false;
  expect(await ask("send", { id: "busy", text: "ordinary" })).toMatchObject({ ok: false });
  fake.api.sendUserMessage = async (text, options) => {
    calls.push({ text, options });
    throw new Error("private native rejection");
  };
  await fake.emit("tool_approval_resolved", { toolCallId: "foreign", sessionId: "different" });
  const steer = { id: "steer", text: "operator steering", steer: true };
  await ask("send", steer);
  expect(calls.at(-1)).toEqual({ text: steer.text, options: { deliverAs: "steer" } });
  expect(data(await ask("receipt", { id: "steer" }))).toMatchObject({ status: "refused" });
  await fake.emit("tool_approval_requested", { toolCallId: "local", sessionId: session });
  await fake.emit("tool_approval_resolved", { toolCallId: "local", sessionId: "different" });
  for (const op of ["send", "model", "interrupt", "close"])
    expect(await ask(op, { id: "locked", text: "no", model: "fixture/two", force: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("local approval"),
    });
  expect(state.aborts).toBe(0);
  expect(state.closes).toBe(0);
});

unixSocketTest("observes actual native messages, asks, reports and completion with explicit event gaps", async () => {
  const { fake, bound } = await fixture();
  fake.session.entries.push(
    { type: "message", id: "u", message: { role: "user", content: "visible" } },
    { type: "message", id: "s", message: { role: "developer", content: "hidden system text" } },
    {
      type: "message",
      id: "a",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "yes" },
        ],
      },
    },
  );
  await fake.emit("session_start");
  const ask = await bound();
  expect(data(await ask("read")).messages).toEqual([
    { id: "u", role: "user", text: "visible" },
    { id: "a", role: "assistant", text: "yes" },
  ]);
  await fake.emit("agent_start");
  await fake.emit("turn_start", { turnIndex: 2 });
  await fake.emit("message_end", { message: { role: "assistant", content: "visible output" } });
  await fake.emit("tool_execution_start", { toolName: "ask", toolCallId: "question" });
  expect(await ask("interrupt")).toMatchObject({ ok: false });
  await fake.emit("tool_execution_end", { toolName: "ask", toolCallId: "question" });
  await fake.emit("tool_execution_end", {
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "[REPORT] lane-key | milestone | observed" }] },
  });
  await fake.emit("turn_end", { turnIndex: 2 });
  await fake.emit("agent_end", { willContinue: true, awaitingAsyncWork: true });
  await fake.emit("agent_end", { willContinue: false });
  const events = data(await ask("events")).events as Array<{ type: string }>;
  expect(events.map((event) => event.type)).toEqual([
    "agent_start",
    "turn_start",
    "message",
    "ask",
    "ask",
    "report",
    "turn_end",
    "agent_yield",
    "completion",
  ]);
  expect(events[5]).toMatchObject({ source: "native-tool-result" });
  for (let i = 0; i < 270; i++) await fake.emit("turn_start", { turnIndex: i });
  expect(data(await ask("events", { cursor: 0, limit: 1 }))).toMatchObject({ gap: true, cursor: 24 });
});

unixSocketTest(
  "interrupt and close do not claim background cancellation; model reads back actual selection",
  async () => {
    const { fake, state, bound, info } = await fixture();
    await fake.emit("session_start");
    const ask = await bound();
    expect(data(await ask("model", { model: "fixture/two" }))).toEqual({ model: "fixture/two" });
    expect((await info()).model).toBe("fixture/two");
    fake.api.setModel = async () => true;
    expect(await ask("model", { model: "fixture/one" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("readback"),
    });
    state.job = true;
    expect(data(await ask("interrupt"))).toEqual({
      status: "idle",
      background: "not-targeted",
      backgroundPending: true,
    });
    expect(await ask("close")).toMatchObject({ ok: false });
    expect(state.aborts).toBe(0);
    state.idle = false;
    expect(data(await ask("interrupt"))).toEqual({
      status: "requested",
      background: "not-targeted",
      backgroundPending: true,
    });
    expect(data(await ask("close", { force: true }))).toEqual({ status: "requested", background: "not-targeted" });
    expect(state.aborts).toBe(2);
    expect(state.closes).toBe(1);
    expect(await ask("send", { id: "closed", text: "not possible" })).toMatchObject({ ok: false });
  },
);

unixSocketTest("rotation invalidates old generations even on the same native session id", async () => {
  const { fake, path, session, info, bound } = await fixture();
  await fake.emit("session_start");
  const initial = await info();
  const old = await bound();
  await fake.emit("session_before_tree");
  expect(await request(path, { op: "info" })).toMatchObject({ ok: false });
  await fake.emit("session_tree");
  expect((await info()).generation).not.toBe(initial.generation);
  expect(await old("send", { id: "old", text: "must not land" })).toMatchObject({ ok: false });
  const afterTree = await bound();
  fake.session.entries.push(
    { type: "message", id: "old", message: { role: "user", content: "before /clear" } },
    { type: "reset_boundary", id: "cleared" },
    { type: "message", id: "new", message: { role: "user", content: "after /clear" } },
  );
  expect(await afterTree("send", { id: "old", text: "must not land after /clear" })).toMatchObject({ ok: false });
  const afterClear = await bound();
  expect(data(await afterClear("read")).messages).toEqual([{ id: "new", role: "user", text: "after /clear" }]);
  fake.session = { id: "other", entries: [] };
  await fake.emit("session_switch", { reason: "resume" });
  await expect(request(path, { op: "info", session })).rejects.toThrow();
  expect(fake.userMessages).toEqual([]);
});

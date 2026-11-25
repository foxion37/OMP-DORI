import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowPolicyOnce, checkPolicyCommand } from "../src/lane-policy-actions.ts";
import { policyBinding, prepareLanePolicy, writeLanePolicy } from "../src/lane-policy-store.ts";
import { Registry } from "../src/registry.ts";
import { type TestState, withState } from "./fakes.ts";

let state: TestState;
let binding: string;
let config: string;
let callerBinding: string | undefined;
let callerSession: string | undefined;
const NOW = Date.parse("2026-01-01T00:00:00Z");
beforeEach(async () => {
  callerBinding = undefined;
  callerSession = undefined;
  state = withState();
  const policy = prepareLanePolicy(state.dir, "demo", { denyBash: ["sudo"] });
  if (!policy) throw new Error("expected policy");
  writeLanePolicy(policy);
  binding = policyBinding(policy);
  config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, agentCommand: ["omp"] }));
  await new Registry(state.dir).create({
    key: "demo",
    title: "test",
    brief: "/test/brief.md",
    done: "file /test/done",
    thread: "none",
    sessionRef: { runtime: "tern", id: "1" },
    cwd: state.dir,
    openedAt: new Date(NOW).toISOString(),
  });
});
afterEach(() => state.done());
const cli = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: state.dir,
      CATALY_HOME: join(state.dir, "harness"),
      CATALY_CONFIG: config,
      CATALY_LANE_POLICY: callerBinding ?? "",
      PI_SESSION_FILE: callerSession ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
};

test("a skill grant refuses an older snapshot even with the same key and rule", async () => {
  const registry = new Registry(state.dir);
  await registry.update("demo", (lane) => (lane ? { ...lane, lifecycleEpoch: randomUUID() } : null));
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
  const denied = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "approved");
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("does not match the registered lane generation");
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
});

test("real CLI grants only the last blocked command and refuses malformed operator requests", async () => {
  checkPolicyCommand(binding, "sudo true", NOW);
  for (const args of [
    [],
    ["demo"],
    ["demo", "denyBash[0]"],
    ["demo", "denyBash[0]", "--reason", " "],
    ["demo", "denyBash[99]", "--reason", "approved"],
    ["demo", "denyBash[0]", "extra", "--reason", "approved"],
    ["demo", "denyBash[0]", "--reason", "one", "--reason", "two"],
    ["missing", "denyBash[0]", "--reason", "approved"],
  ]) {
    const result = await cli("policy", "allow-once", ...args);
    expect(result.code).toBe(1);
    expect(result.err.length).toBeGreaterThan(0);
  }
  const grant = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "owner approved this command");
  expect(grant).toMatchObject({ code: 0, err: "" });
  expect(grant.out).toContain("POLICY_ALLOW_ONCE demo rule=denyBash[0]");
  expect(grant.out).toContain("native approvals still apply");
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toBeUndefined();
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
});

test("a policy-bound lane cannot grant its own exception", async () => {
  checkPolicyCommand(binding, "sudo true", NOW);
  callerBinding = binding;
  const denied = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "self approved");
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("not a policy-bound lane");
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
});

test.each(["omp-cataly:lane-policy"])(
  "a resumed %s policy transcript cannot grant exceptions without a launch environment",
  async (customType) => {
    checkPolicyCommand(binding, "sudo true", NOW);
    callerSession = join(state.dir, "resumed.jsonl");
    writeFileSync(
      callerSession,
      [
        { type: "session", version: 3, id: "resumed-lane", timestamp: new Date(NOW).toISOString(), cwd: state.dir },
        { type: "custom", id: "role", parentId: null, customType: "omp-cataly:role", data: "lane" },
        { type: "custom", id: "policy", parentId: "role", customType, data: binding },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const denied = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "self approved on resume");
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("not a policy-bound lane");
    expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
  },
);

test("an unbound native owner or lead can grant, but an unreadable caller cannot", async () => {
  checkPolicyCommand(binding, "sudo true", NOW);
  callerSession = join(state.dir, "lead.jsonl");
  for (const content of [undefined, "not json", ""]) {
    if (content !== undefined) writeFileSync(callerSession, content);
    const denied = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "owner approved");
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("cannot inspect caller session");
    expect(denied.err).not.toContain(" at ");
    expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
  }
  writeFileSync(
    callerSession,
    [
      { type: "session", version: 3, id: "lead", timestamp: new Date(NOW).toISOString(), cwd: state.dir },
      { type: "custom", id: "role", parentId: null, customType: "omp-cataly:role", data: "cataly" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const grant = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "owner approved this command");
  expect(grant).toMatchObject({ code: 0, err: "" });
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toBeUndefined();
});

test("missing and malformed snapshots produce operator errors without stack traces", async () => {
  const file = join(state.dir, "lanes/demo/policy.json");
  unlinkSync(file);
  const absent = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "approved");
  expect(absent.code).toBe(1);
  expect(absent.err).toContain("lane demo has no policy snapshot");
  expect(absent.err).not.toContain(" at ");
  writeFileSync(file, "not json");
  const corrupt = await cli("policy", "allow-once", "demo", "denyBash[0]", "--reason", "approved");
  expect(corrupt.code).toBe(1);
  expect(corrupt.err).toContain("invalid lane policy snapshot JSON");
  expect(corrupt.err).not.toContain(" at ");
});

test("policy CLI stays lazy: version works with an unreadable configuration", async () => {
  writeFileSync(config, "not json");
  const version = await cli("--version");
  expect(version.code).toBe(0);
  expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  expect(version.err).toBe("");
});

test("one grant cannot be consumed twice by independent processes", async () => {
  checkPolicyCommand(binding, "sudo true", NOW);
  allowPolicyOnce(binding, "denyBash[0]", "owner approved", NOW);
  const entry = join(import.meta.dir, "../src/lane-policy-actions.ts");
  const source = `import { checkPolicyCommand } from ${JSON.stringify(entry)};
    try { const reason = checkPolicyCommand(${JSON.stringify(binding)}, "sudo true", Date.now());
      console.log(JSON.stringify({ allowed: reason === undefined, reason })); }
    catch (error) { console.log(JSON.stringify({ allowed: false, reason: error.message })); }`;
  const attempts = await Promise.all(
    Array.from({ length: 6 }, async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
        env: { PATH: process.env["PATH"] ?? "", HOME: state.dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      return JSON.parse(out) as { allowed: boolean; reason?: string };
    }),
  );
  expect(attempts.filter((result) => result.allowed)).toHaveLength(1);
  for (const result of attempts.filter((result) => !result.allowed))
    expect(result.reason).toMatch(/LANE_POLICY_BLOCKED|lane policy held/);
});

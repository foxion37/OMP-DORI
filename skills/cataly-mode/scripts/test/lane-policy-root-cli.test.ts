import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../../../src/store.ts";
import { checkPolicyCommand } from "../src/lane-policy-actions.ts";
import { policyBinding, prepareLanePolicy, writeLanePolicy } from "../src/lane-policy-store.ts";
import { Registry } from "../src/registry.ts";
import { type TestState, withState } from "./fakes.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

function rootPolicy(configState: string) {
  const key = "demo";
  const id = randomUUID();
  const policy = prepareLanePolicy(state.dir, key, { denyBash: ["sudo"] }, id);
  if (!policy) throw new Error("expected root policy");
  writeLanePolicy(policy, { key, lifecycleEpoch: id });
  const policyRef = policyBinding(policy);
  const home = join(state.dir, "harness");
  const store = new Store(home);
  store.saveLane({
    key,
    sessionRef: { runtime: "headless", id },
    policyBinding: policyRef,
    brief: "/test/root-brief.md",
    cwd: state.dir,
    status: "working",
    createdAt: NOW,
    lastActivityAt: NOW,
    progressAt: NOW,
    noticeId: "demo-notice",
    progressEpoch: 0,
    nudges: 0,
    log: [],
  });
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: configState, agentCommand: ["omp"] }));
  const grant = async (args: readonly string[], callerBinding = "") => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "policy",
        "allow-once",
        key,
        "denyBash[0]",
        "--reason",
        "approved",
        ...args,
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: state.dir,
          CATALY_HOME: home,
          CATALY_CONFIG: config,
          CATALY_LANE_POLICY: callerBinding,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, err };
  };
  return { store, address: `headless:${id}`, policyRef, grant };
}

test("an explicit root grant binds the registered reservation and never aliases the same-key skill lane", async () => {
  const key = "demo";
  const skill = prepareLanePolicy(state.dir, key, { denyBash: ["sudo"] });
  if (!skill) throw new Error("expected skill policy");
  const lifecycleEpoch = randomUUID();
  writeLanePolicy(skill, { key, lifecycleEpoch });
  const binding = policyBinding(skill);
  await new Registry(state.dir).create({
    key,
    title: "skill lane",
    brief: "/test/brief.md",
    done: "file /test/done",
    thread: "none",
    sessionRef: { runtime: "tern", id: "2" },
    openedAt: new Date(NOW).toISOString(),
    lifecycleEpoch,
  });
  const { store, address, policyRef, grant } = rootPolicy(state.dir);
  expect(checkPolicyCommand(policyRef, "sudo root", NOW)).toContain(`--root ${address}`);
  expect(checkPolicyCommand(binding, "sudo skill", NOW)).toContain("BLOCKED");
  expect(await grant([])).toMatchObject({ code: 1, err: expect.stringContaining("exists in both registries") });
  expect(await grant(["--root", address], policyRef)).toMatchObject({
    code: 1,
    err: expect.stringContaining("not a policy-bound lane"),
  });

  const root = await grant(["--root", address]);
  expect(root).toMatchObject({ code: 0, err: "" });
  expect(root.out).toContain(`root=${address}`);
  expect(checkPolicyCommand(policyRef, "sudo wrong command", NOW)).toContain("BLOCKED");
  expect(checkPolicyCommand(policyRef, "sudo root", NOW)).toBeUndefined();
  expect(checkPolicyCommand(policyRef, "sudo root", NOW)).toContain("BLOCKED");
  expect(checkPolicyCommand(binding, "sudo skill", NOW)).toContain("BLOCKED");
  expect(await grant(["--skill"])).toMatchObject({ code: 0, err: "" });
  expect(checkPolicyCommand(binding, "sudo skill", NOW)).toBeUndefined();
  expect(checkPolicyCommand(policyRef, "sudo root", NOW)).toContain("BLOCKED");

  const nextId = randomUUID();
  store.saveLane({ ...store.lane(key)!, sessionRef: { runtime: "headless", id: nextId } });
  expect(await grant(["--root", address])).toMatchObject({
    code: 1,
    err: expect.stringContaining("no matching open root registration"),
  });
  expect(await grant(["--root", `headless:${nextId}`])).toMatchObject({
    code: 1,
    err: expect.stringContaining("policy snapshot does not match"),
  });
  expect(checkPolicyCommand(policyRef, "sudo root", NOW)).toContain("BLOCKED");
});

test("a root-only lane grants from its registration, not the skill configuration's state directory", async () => {
  const { address, policyRef, grant } = rootPolicy(join(state.dir, "elsewhere"));
  expect(checkPolicyCommand(policyRef, "sudo true", NOW)).toContain("BLOCKED");
  expect(await grant([])).toMatchObject({ code: 1, err: expect.stringContaining("requires --root") });
  expect(await grant(["--root", address])).toMatchObject({ code: 0, err: "" });
  expect(checkPolicyCommand(policyRef, "sudo true", NOW)).toBeUndefined();
});

test("--root takes the unique prefix harness status shows and refuses one that names two sessions", async () => {
  const { store, address, policyRef, grant } = rootPolicy(state.dir);
  const short = address.slice(0, "headless:".length + 8);
  expect(checkPolicyCommand(policyRef, "sudo true", NOW)).toContain("BLOCKED");
  expect(await grant(["--root", short])).toMatchObject({ code: 0, err: "" });
  expect(checkPolicyCommand(policyRef, "sudo true", NOW)).toBeUndefined();
  const twin = `${address.slice("headless:".length, "headless:".length + 8)}-0000-4000-8000-000000000000`;
  store.saveLane({ ...store.lane("demo")!, key: "twin", sessionRef: { runtime: "headless", id: twin } });
  expect(await grant(["--root", short])).toMatchObject({
    code: 1,
    err: expect.stringContaining(`${short} is ambiguous`),
  });
  expect(checkPolicyCommand(policyRef, "sudo true", NOW)).toContain("BLOCKED");
});

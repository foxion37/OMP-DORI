import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { takeLock } from "../src/checkpoint-lock.ts";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import { allowPolicyOnce, checkPolicyCommand } from "../src/lane-policy-actions.ts";
import { checkLanePolicy, PolicyError } from "../src/lane-policy.ts";
import {
  currentLanePolicy,
  policyBinding,
  prepareLanePolicy,
  readLanePolicy,
  writeLanePolicy,
} from "../src/lane-policy-store.ts";
import { Reports } from "../src/reports.ts";
import { type TestState, withState } from "./fakes.ts";

let state: TestState;
const NOW = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const snapshot = (denyBash = ["\\bsudo\\b"]) => {
  const policy = prepareLanePolicy(state.dir, "demo", { denyBash });
  if (!policy) throw new Error("expected configured policy");
  writeLanePolicy(policy);
  return { policy, binding: policyBinding(policy) };
};

test("policy is opt-in and config rejects malformed regex policies with the established error type", async () => {
  expect(prepareLanePolicy(state.dir, "demo", undefined)).toBeUndefined();
  expect(readdirSync(state.dir)).toEqual([]);
  const file = join(state.dir, "config.json");
  writeFileSync(file, JSON.stringify({ lanePolicy: { denyBash: ["sudo"] } }));
  expect((await loadConfig(file, state.dir)).lanePolicy?.denyBash).toEqual(["sudo"]);
  for (const lanePolicy of [
    null,
    {},
    [],
    { denyBash: ["["] },
    { denyBash: [""] },
    { denyBash: [4] },
    { denyBash: [], typo: [] },
    { denyBash: [], perLane: [] },
    { denyBash: [], perLane: { "../*": { allowBash: [] } } },
    { denyBash: [], perLane: { "*": { allowBash: ["["] } } },
  ]) {
    expect(() => checkLanePolicy(lanePolicy)).toThrow(PolicyError);
    writeFileSync(file, JSON.stringify({ lanePolicy }));
    await expect(loadConfig(file, state.dir)).rejects.toThrow(ConfigError);
  }
});

test("lane glob exceptions match a whole command, not a compound suffix or another lane", () => {
  const policy = prepareLanePolicy(state.dir, "deploy-alpha", {
    denyBash: ["sudo"],
    perLane: { "deploy-*": { allowBash: ["sudo deploy\\.py"] } },
  });
  if (!policy) throw new Error("expected policy");
  writeLanePolicy(policy);
  const binding = policyBinding(policy);
  expect(checkPolicyCommand(binding, "sudo deploy.py", NOW)).toBeUndefined();
  expect(readdirSync(dirname(policy.file))).toEqual(["policy.json"]);
  expect(checkPolicyCommand(binding, "sudo deploy.py; sudo rm data", NOW)).toContain("LANE_POLICY_BLOCKED");
  expect(checkPolicyCommand(binding, "sudo deploy.py\nsudo rm data", NOW)).toContain("LANE_POLICY_BLOCKED");
  expect(checkPolicyCommand(binding, "sudo deploy.py\n", NOW)).toContain("LANE_POLICY_BLOCKED");
  expect(
    prepareLanePolicy(state.dir, "review-alpha", { denyBash: ["sudo"], perLane: { "deploy-*": { allowBash: [".*"] } } })
      ?.snapshot.allowBash,
  ).toEqual([]);
});

test("the blocker stays with the bound launch rather than a later or unrelated run", () => {
  const policy = prepareLanePolicy(state.dir, "demo", { denyBash: ["marker"] });
  if (!policy) throw new Error("expected policy");
  const requestId = "discord:100:200";
  const runId = "5e411b95-b744-4fec-a712-48c7ff98ffaa";
  const generation = "fixture-generation";
  writeLanePolicy(policy, { key: "demo", lifecycleEpoch: generation, requestId, runId });
  expect(checkPolicyCommand(policyBinding(policy), "echo marker", NOW)).toContain("LANE_POLICY_BLOCKED");
  const reports = new Reports(state.dir);
  expect(reports.read("demo", { generation, requestId, runId })?.state).toBe("blocked");
  expect(reports.read("demo", { generation: "other-generation", requestId, runId })).toBeNull();
  expect(reports.read("demo", { generation })).toBeNull();
});

test("denials are durable and deduplicated without putting command secrets in the report", () => {
  const { binding } = snapshot();
  const command = "sudo echo very-sensitive-fixture";
  expect(checkPolicyCommand(binding, command, NOW)).toContain("denyBash[0]");
  const policy = readLanePolicy(binding);
  const file = join(dirname(policy.file), `policy-grants-${policy.snapshot.id}.json`);
  const inode = statSync(file).ino;
  expect(checkPolicyCommand(binding, command, NOW + 1)).toContain("denyBash[0]");
  expect(statSync(file).ino).toBe(inode);
  const reports = new Reports(state.dir);
  expect(reports.read("demo")?.state).toBe("blocked");
  const journal = readFileSync(reports.path("demo"), "utf8");
  expect(journal.trim().split("\n")).toHaveLength(1);
  expect(journal).toContain("command-sha256=");
  expect(journal).not.toContain("very-sensitive-fixture");
  expect(checkPolicyCommand(binding, "echo safe", NOW)).toBeUndefined();
});

test("unmatched commands do not acquire the grant lock or inspect unrelated grant state", () => {
  const { binding, policy } = snapshot();
  const file = join(dirname(policy.file), `policy-grants-${policy.snapshot.id}.json`);
  writeFileSync(file, "corrupt grant state");
  const release = takeLock(`${file}.lock`, NOW, (message) => new Error(message), { keepLiveOwner: true });
  if (typeof release === "string") throw new Error(release);
  try {
    expect(checkPolicyCommand(binding, "echo safe", NOW)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("corrupt grant state");
    expect(() => checkPolicyCommand(binding, "sudo true", NOW)).toThrow("lane policy held");
  } finally {
    release();
  }
});

test("one grant is bound to the exact command, survives reload, and admits only one attempt", () => {
  const { binding } = snapshot();
  expect(() => allowPolicyOnce(binding, "denyBash[0]", "owner approved", NOW)).toThrow("most recently blocked");
  checkPolicyCommand(binding, "sudo echo first", NOW);
  const grant = allowPolicyOnce(binding, "denyBash[0]", "owner approved", NOW + 1);
  expect(allowPolicyOnce(binding, "denyBash[0]", "same approval", NOW + 2)).toEqual(grant);
  expect(checkPolicyCommand(binding, "sudo echo second", NOW + 3)).toContain("BLOCKED");
  const reloaded = policyBinding(currentLanePolicy(state.dir, "demo"));
  expect(checkPolicyCommand(reloaded, "sudo echo first", NOW + 4)).toBeUndefined();
  expect(() => allowPolicyOnce(reloaded, "denyBash[0]", "approve the newer second command", NOW + 5)).not.toThrow();
  expect(checkPolicyCommand(reloaded, "sudo echo second", NOW + 6)).toBeUndefined();
  expect(checkPolicyCommand(reloaded, "sudo echo first", NOW + 7)).toContain("BLOCKED");
});

test("a repeated denial restores the effective blocker after intervening progress", () => {
  const { binding } = snapshot();
  const reports = new Reports(state.dir);
  checkPolicyCommand(binding, "sudo true", NOW);
  reports.report("demo", "milestone", "finished other work", NOW + 1);
  expect(checkPolicyCommand(binding, "sudo true", NOW + 2)).toContain("BLOCKED");
  expect(reports.read("demo")?.state).toBe("blocked");
  expect(reports.read("demo")?.lastReport?.text).toContain("LANE_POLICY_BLOCKED");
});

test("all matching rules need grants, and a partial attempt consumes none", () => {
  const { binding } = snapshot(["sudo", "rm"]);
  const command = "sudo rm fixture";
  checkPolicyCommand(binding, command, NOW);
  allowPolicyOnce(binding, "denyBash[0]", "approved sudo", NOW);
  expect(checkPolicyCommand(binding, command, NOW)).toContain("denyBash[1]");
  allowPolicyOnce(binding, "denyBash[1]", "approved rm", NOW);
  expect(checkPolicyCommand(binding, command, NOW)).toBeUndefined();
  expect(new Reports(state.dir).read("demo")?.state).toBe("running");
  expect(checkPolicyCommand(binding, command, NOW)).toContain("BLOCKED");
});

test("admission clears only its own blocker, not an unrelated later blocker", () => {
  const { binding } = snapshot();
  checkPolicyCommand(binding, "sudo true", NOW);
  allowPolicyOnce(binding, "denyBash[0]", "approved", NOW);
  new Reports(state.dir).report("demo", "blocker", "waiting for deployment approval", NOW);
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toBeUndefined();
  expect(new Reports(state.dir).read("demo")?.lastReport?.text).toBe("waiting for deployment approval");
});

test("unknown rules and empty reasons never create grants", () => {
  const { binding } = snapshot();
  checkPolicyCommand(binding, "sudo true", NOW);
  expect(() => allowPolicyOnce(binding, "denyBash[0]", " ", NOW)).toThrow("approval reason");
  expect(() => allowPolicyOnce(binding, "denyBash[1]", "approved", NOW)).toThrow("most recently blocked");
  expect(checkPolicyCommand(binding, "sudo true", NOW)).toContain("BLOCKED");
});

test("a new policy generation invalidates old bindings and never reuses old grants", () => {
  const first = snapshot();
  checkPolicyCommand(first.binding, "sudo true", NOW);
  allowPolicyOnce(first.binding, "denyBash[0]", "approved", NOW);
  const second = snapshot();
  expect(() => readLanePolicy(first.binding)).toThrow("identity mismatch");
  expect(checkPolicyCommand(second.binding, "sudo true", NOW)).toContain("BLOCKED");
});

test("malformed grant journals and bindings fail closed rather than dropping restrictions", () => {
  const { binding, policy } = snapshot();
  expect(() => readLanePolicy("{}")).toThrow("invalid lane policy binding");
  expect(() => readLanePolicy(JSON.stringify({ file: "relative", id: policy.snapshot.id }))).toThrow();
  const file = join(dirname(policy.file), `policy-grants-${policy.snapshot.id}.json`);
  for (const value of [
    null,
    {},
    { id: policy.snapshot.id, grants: [{}] },
    { id: policy.snapshot.id, grants: [], blocked: { hash: "bad", rules: [] } },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    expect(() => checkPolicyCommand(binding, "sudo true", NOW)).toThrow();
  }
});

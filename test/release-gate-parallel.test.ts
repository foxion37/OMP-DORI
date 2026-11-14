import { expect, test } from "bun:test";
import { releaseGate } from "../scripts/release-gate.ts";
import { githubFixture } from "./release-producer-setup.ts";

function pendingChecks() {
  const f = githubFixture();
  const api = f.reads.api;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runReads = 0;
  f.reads.api = async (path) => {
    if (path === `${f.prefix}/actions/runs/70`) runReads++;
    if (!path.startsWith(`${f.prefix}/check-runs/`)) return api(path);
    return new Promise((resolve, reject) => {
      pending.set(path, { resolve, reject });
      if (pending.size === 4) started();
    });
  };
  const finish = async (id: number, error?: Error) => {
    const path = `${f.prefix}/check-runs/${id}`;
    const read = pending.get(path)!;
    if (error) read.reject(error);
    else read.resolve(await api(path));
  };
  return { f, pending, allStarted, finish, runReads: () => runReads };
}

test("overlaps exactly four check GETs and waits for all before the final run read", async () => {
  const p = pendingChecks();
  const result = releaseGate(p.f.manifest, p.f.reads);
  await p.allStarted;
  expect(p.pending.size).toBe(4);
  expect(p.runReads()).toBe(1);
  for (const id of [103, 101, 102]) await p.finish(id);
  expect(p.runReads()).toBe(1);
  await p.finish(100);
  await result;
  expect(p.runReads()).toBe(2);
});

test("drains rejected reads, keeps required-job error order and never performs the final gate read", async () => {
  const p = pendingChecks();
  let settled = false;
  const result = releaseGate(p.f.manifest, p.f.reads).catch((error: unknown) => {
    settled = true;
    return error;
  });
  await p.allStarted;
  await p.finish(103, new Error("fourth transport"));
  await p.finish(100, new Error("first transport"));
  await p.finish(102);
  await Promise.resolve();
  expect(settled).toBe(false);
  await p.finish(101);
  expect(((await result) as Error).message).toBe("first transport");
  expect(p.runReads()).toBe(1);
});

test("rejects a bad binding despite out-of-order successful responses", async () => {
  const p = pendingChecks();
  p.f.checks[1]!.app.id = 999;
  const result = releaseGate(p.f.manifest, p.f.reads).catch((error: unknown) => error);
  await p.allStarted;
  for (const id of [103, 102, 101, 100]) await p.finish(id);
  expect(((await result) as Error).message).toContain("test-macos");
  expect(p.runReads()).toBe(1);
});

test.each(["attempt", "main", "tag"])("still rejects a %s move while concurrent reads are in flight", async (kind) => {
  const p = pendingChecks();
  const result = releaseGate(p.f.manifest, p.f.reads).catch((error: unknown) => error);
  await p.allStarted;
  if (kind === "attempt") p.f.run["run_attempt"] = 3;
  if (kind === "main") p.f.responses[`${p.f.prefix}/branches/main`] = { commit: { sha: "9".repeat(40) } };
  if (kind === "tag")
    p.f.responses[`${p.f.prefix}/git/ref/tags/${p.f.manifest.tag}`] = {
      object: { type: "commit", sha: "9".repeat(40) },
    };
  for (const id of [101, 103, 100, 102]) await p.finish(id);
  expect(((await result) as Error).message).toContain("changed");
});

test("validates all required jobs before making any concurrent check request", async () => {
  const p = pendingChecks();
  p.f.jobs[3]!["conclusion"] = "failure";
  await expect(releaseGate(p.f.manifest, p.f.reads)).rejects.toThrow("did not succeed");
  expect(p.pending.size).toBe(0);
});

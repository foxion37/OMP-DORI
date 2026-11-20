import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishUlwCandidate } from "../scripts/update-ulw-publish.ts";
import { ulwPublicationFixture as fixture } from "./update-ulw-publish-setup.ts";

// POSIX-only: the published bundle is admitted by permission-bit checks (0o022) that Windows files cannot pass.
const it = test.skipIf(process.platform === "win32");

it("publication changes only three metadata blobs on a new draft branch and dispatches exact-head CI", async () => {
  const f = await fixture();
  const url = await publishUlwCandidate(f.source, f.directory, f.api);
  expect(url).toBe("https://github.com/vntrevx/Cataly/pull/999");
  expect(f.calls.every((call) => call.path.startsWith("repos/vntrevx/Cataly/"))).toBe(true);
  const tree = f.calls.find((call) => call.path.endsWith("/git/trees"))!.body as { tree: { path: string }[] };
  expect(tree.tree.map((entry) => entry.path)).toEqual(["omp-ulw.lock", "omp-ulw.overlay.lock", "omp-ulw.patch"]);
  expect(f.calls.find((call) => call.path.endsWith("/pulls"))!.body).toMatchObject({
    draft: true,
    head: f.branch,
    base: "main",
  });
  expect(f.calls.find((call) => call.path.endsWith("/dispatches"))!.body).toEqual({ ref: f.branch });
  expect(f.calls.some((call) => call.method === "PATCH" || /merge|releases|tags/.test(call.path))).toBe(false);
  f.calls.length = 0;
  expect(await publishUlwCandidate(f.source, f.directory, f.api)).toBe(url);
  expect(f.calls.some((call) => /dispatches|\/pulls$|\/git\/refs$|\/git\/commits$/.test(call.path))).toBe(false);
});

it("closed/rejected candidates are never reopened or redispatched", async () => {
  const f = await fixture();
  await publishUlwCandidate(f.source, f.directory, f.api);
  f.state.pull!.state = "closed";
  f.state.runs = [];
  f.calls.length = 0;
  await publishUlwCandidate(f.source, f.directory, f.api);
  expect(f.calls.some((call) => call.path.endsWith("/dispatches") || call.path.endsWith("/pulls"))).toBe(false);
});

it("a PR-created but unstarted CI dispatch recovers without duplicate branches or pull requests", async () => {
  const f = await fixture();
  f.state.dispatchFail = true;
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("Dispatch unavailable");
  f.state.dispatchFail = false;
  f.calls.length = 0;
  await publishUlwCandidate(f.source, f.directory, f.api);
  expect(f.calls.filter((call) => call.path.endsWith("/dispatches"))).toHaveLength(1);
  expect(f.calls.some((call) => /\/git\/refs$|\/pulls$/.test(call.path))).toBe(false);
});

it("main advancement or edited automatic branch is held, never force-pushed", async () => {
  const f = await fixture();
  f.state.main = "f".repeat(40);
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("Main advanced");
  expect(f.calls.some((call) => call.method !== "GET")).toBe(false);
  f.state.main = f.candidate.sourceCommit;
  f.state.branch = true;
  f.state.foreign = true;
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("branch changed");
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false);
});

it("tampered receipts, bundle bytes, and unexpected artifact paths never reach GitHub", async () => {
  const f = await fixture();
  const receipt = join(f.directory, "candidate.json");
  const original = readFileSync(receipt);
  writeFileSync(receipt, JSON.stringify({ ...f.candidate, commit: "../main" }));
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("receipt");
  writeFileSync(receipt, original);
  writeFileSync(join(f.directory, "foreign.ts"), "throw new Error('must not execute');\n");
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("Unexpected");
  rmSync(join(f.directory, "foreign.ts"));
  writeFileSync(join(f.directory, "omp-ulw.patch"), "tampered\n");
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow("digest");
  expect(f.calls).toEqual([]);
});

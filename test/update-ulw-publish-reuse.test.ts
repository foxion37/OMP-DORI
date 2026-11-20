import { expect, test } from "bun:test";
import { publishUlwCandidate } from "../scripts/update-ulw-publish.ts";
import { ulwPublicationFixture } from "./update-ulw-publish-setup.ts";

// Every case prepares a trusted source bundle, which requires POSIX write-permission bits.
const posix = test.skipIf(process.platform === "win32");

for (const advanced of [false, true]) {
  posix.each(["open", "closed"])(
    `verified %s candidate is reused without object writes when main advanced=${advanced}`,
    async (state) => {
      const f = await ulwPublicationFixture();
      const url = await publishUlwCandidate(f.source, f.directory, f.api);
      f.state.pull!.state = state;
      const next = advanced ? await f.advanceMain() : f;
      expect(next.candidate.commit).toBe(f.candidate.commit);
      expect(next.candidate.previousIdentity).toBe(f.candidate.previousIdentity);
      for (let attempt = 0; attempt < 2; attempt++) {
        f.calls.length = 0;
        expect(await publishUlwCandidate(f.source, next.directory, f.api)).toBe(url);
        expect(f.calls.every((call) => call.method === "GET")).toBe(true);
      }
    },
  );
}

posix("an open candidate dispatches its original head if CI never started", async () => {
  const f = await ulwPublicationFixture();
  await publishUlwCandidate(f.source, f.directory, f.api);
  const next = await f.advanceMain();
  f.state.runs = [];
  f.calls.length = 0;
  await publishUlwCandidate(f.source, next.directory, f.api);
  const writes = f.calls.filter((call) => call.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: "repos/vntrevx/Cataly/actions/workflows/ci.yml/dispatches",
    body: { ref: f.branch },
  });
  expect(f.calls.some((call) => call.path.includes(`head_sha=${f.commit}&event=workflow_dispatch`))).toBe(true);
});

posix.each(["previousMetadataChanged", "candidateMetadataChanged", "unrelatedTreeChanged", "ancestor"] as const)(
  "same named candidate does not bypass the %s fence after main advances",
  async (field) => {
    const f = await ulwPublicationFixture();
    await publishUlwCandidate(f.source, f.directory, f.api);
    const next = await f.advanceMain();
    f.state[field] = field !== "ancestor";
    f.calls.length = 0;
    await expect(publishUlwCandidate(f.source, next.directory, f.api)).rejects.toThrow();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  },
);

posix.each(["url", "head-repo", "head-ref", "head-sha", "base-repo", "base-ref", "state"])(
  "an existing PR with mismatched %s is held before publication or dispatch",
  async (field) => {
    const f = await ulwPublicationFixture();
    await publishUlwCandidate(f.source, f.directory, f.api);
    const p = f.state.pull!;
    if (field === "url") p.html_url = "https://github.com/other/Cataly/pull/999";
    if (field === "head-repo") p.head.repo.full_name = "other/Cataly";
    if (field === "head-ref") p.head.ref = "unrelated";
    if (field === "head-sha") p.head.sha = "f".repeat(40);
    if (field === "base-repo") p.base.repo.full_name = "other/Cataly";
    if (field === "base-ref") p.base.ref = "unrelated";
    if (field === "state") p.state = "unknown";
    f.calls.length = 0;
    await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  },
);

posix("an existing PR with a missing branch is held, not silently recreated", async () => {
  const f = await ulwPublicationFixture();
  await publishUlwCandidate(f.source, f.directory, f.api);
  f.state.branch = false;
  f.calls.length = 0;
  await expect(publishUlwCandidate(f.source, f.directory, f.api)).rejects.toThrow();
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

posix("an orphan branch from before main advancement remains held without rewriting it", async () => {
  const f = await ulwPublicationFixture();
  await publishUlwCandidate(f.source, f.directory, f.api);
  f.state.pull = undefined;
  const next = await f.advanceMain();
  f.calls.length = 0;
  await expect(publishUlwCandidate(f.source, next.directory, f.api)).rejects.toThrow("branch changed");
  expect(f.calls.some((call) => /\/pulls$|dispatches|\/git\/refs$/.test(call.path) || call.method === "PATCH")).toBe(
    false,
  );
});

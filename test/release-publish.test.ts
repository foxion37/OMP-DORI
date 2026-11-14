import { expect, test } from "bun:test";
import { ReleaseJournal } from "../scripts/release-journal.ts";
import { notes } from "../scripts/release-remote.ts";
import { publisherFixture } from "./release-publish-setup.ts";

test.each([false, true])(
  "the complete producer preserves draft identity and verifies publication with a stale release list: %s",
  async (staleList) => {
    const f = publisherFixture({ staleList });
    expect(await f.publish()).toEqual({ code: 0, err: "" });
    const state = f.remote();
    expect(state.release).toMatchObject({
      id: 443,
      tag_name: f.manifest.tag,
      target_commitish: f.manifest.commit,
      name: `OMP-Dori ${f.manifest.tag}`,
      prerelease: true,
      draft: false,
      body: notes(f.manifest),
    });
    expect(state.creates).toBe(1);
    expect(state.publishes).toBe(1);
    expect(state.rebindings).toBe(0);
    expect(state.patches).toBe(Object.keys(f.assets).length + 2);
    expect(state.listsAfterCreate).toBeGreaterThan(0);
    expect(Object.keys(state.uploads).sort()).toEqual(Object.keys(f.assets).sort());
    for (const [name, bytes] of Object.entries(f.assets)) {
      expect(Buffer.from(state.uploads[name]!.bytes, "base64").equals(bytes)).toBe(true);
    }
    expect(new ReleaseJournal(f.directory, f.manifest).pending).toBeUndefined();
    if (!staleList) {
      expect(await f.publish()).toEqual({ code: 0, err: "" });
      expect(f.remote()).toMatchObject({ creates: 1, patches: state.patches, publishes: 1 });
    }
  },
  20_000,
);

test("a lost create response can reconcile through the existing list without a second POST", async () => {
  const f = publisherFixture({ lostCreate: true });
  expect(await f.publish()).toEqual({ code: 0, err: "" });
  expect(f.remote()).toMatchObject({
    creates: 1,
    publishes: 1,
    rebindings: 0,
    release: { id: 443, tag_name: f.manifest.tag, draft: false, body: notes(f.manifest) },
  });
  expect(new ReleaseJournal(f.directory, f.manifest).pending).toBeUndefined();
}, 20_000);

test("a lost create response and stale list retain the create intent across restart without replay", async () => {
  const f = publisherFixture({ lostCreate: true, staleList: true });
  const first = await f.publish();
  expect(first.code).not.toBe(0);
  expect(first.err).toContain("Ambiguous publication create");
  expect(new ReleaseJournal(f.directory, f.manifest).pending).toBe("create");
  const resumed = await f.publish();
  expect(resumed.code).not.toBe(0);
  expect(resumed.err).toContain("Unresolved create");
  expect(f.remote()).toMatchObject({ creates: 1, patches: 0, publishes: 0, uploads: {}, release: { draft: true } });
  expect(new ReleaseJournal(f.directory, f.manifest).pending).toBe("create");
}, 20_000);

test.each(["id", "tag", "commit", "source"] as const)(
  "known-ID confirmation holds when the live release changes its %s binding",
  async (changedRead) => {
    const f = publisherFixture({ staleList: true, changedRead });
    const result = await f.publish();
    expect(result.code).not.toBe(0);
    expect(result.err).toContain(
      changedRead === "id" || changedRead === "tag"
        ? "GitHub release identity changed during readback"
        : "Existing release metadata is not this producer's immutable committed release",
    );
    expect(f.remote()).toMatchObject({ creates: 1, patches: 0, publishes: 0, uploads: {} });
    expect(new ReleaseJournal(f.directory, f.manifest).pending).toBe("create");
  },
  20_000,
);

test("changed uploaded bytes retain the upload intent without overwriting or publishing", async () => {
  const f = publisherFixture({ corruptUpload: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.publish();
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Release asset digest differs from committed distribution: SHA256SUMS");
    expect(new ReleaseJournal(f.directory, f.manifest).pending).toBe("upload:SHA256SUMS");
  }
  expect(f.remote()).toMatchObject({ creates: 1, patches: 1, publishes: 0 });
  expect(Object.keys(f.remote().uploads)).toEqual(["SHA256SUMS"]);
}, 20_000);

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadUpdateConfig } from "../src/update/load.ts";
import { publicationBasis } from "../src/update/publish-basis.ts";
import { publicSource } from "../src/update/publish-export.ts";
import { PublicationProcess } from "../src/update/publish-process.ts";
import { publishRelease } from "../src/update/publish.ts";
import { PublicationHold, type PublicationRecord } from "../src/update/publish-types.ts";
import { persistJob, persistState, readJob, readState, saveJson } from "../src/update/state.ts";
import { git, publicationFixture } from "./update-setup.ts";
import { bootstrapFixture } from "./update-publish-setup.ts";

let exportHash: string;
beforeAll(async () => {
  // Share only the checked export hash; every case still prepares its own isolated candidate.
  exportHash = publicSource((await publicationFixture()).job).hash;
});

test("owner content missing from frozen local input holds before any durable publication intent", async () => {
  const f = await publicationFixture();
  const commands = structuredClone(f.job.commands);
  const review = structuredClone(f.job.review);
  const history = structuredClone(f.job.history);
  f.write(f.seed, "owner-history.txt", "owner content must survive publication\n");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "Owner content outside the frozen local source");
  const owner = git(f.seed, "rev-parse", "HEAD");
  git(f.seed, "push", f.target, "HEAD:refs/heads/main");
  expect(existsSync(join(f.job.candidate, "owner-history.txt"))).toBe(false);
  const result = await f.updater.once();
  expect(result.outcome).toBe("held");
  expect(result.job?.promotion?.publication).toBeUndefined();
  expect(result.job?.promotion?.status).toBe("held");
  expect(result.job?.promotion?.problem).toContain("frozen public local source differs");
  expect(git(f.target, "rev-parse", "main")).toBe(owner);
  expect(git(f.target, "show", "main:owner-history.txt")).toBe("owner content must survive publication");
  expect(git(f.target, "for-each-ref", "--format=%(refname)", "refs/heads/dori-update/")).toBe("");
  expect(result.job?.phase).toBe("ready");
  expect(result.job?.commands).toEqual(commands);
  expect(result.job?.review).toEqual(review);
  expect(result.job?.history).toEqual(history);
  expect(readState(f.updater.context).baseline).toBeUndefined();
});

describe("initial-source pin binding", () => {
  test.each([
    "exact",
    "source-mismatch",
    "main-mismatch",
    "export-mismatch",
    "base-mismatch",
    "upstream-mismatch",
  ] as const)("initial source publication requires all five exact approved pins: %s", async (binding) => {
    const f = await bootstrapFixture(binding, false, exportHash);
    expect(publicSource(f.job).hash).toBe(exportHash);
    const result = await f.updater.once();
    if (binding === "exact") {
      expect(result.outcome).toBe("promoted");
      const publication = result.job!.promotion!.publication!;
      const commit = publication.commit!;
      expect(publication.basis).toEqual({ kind: "initial-source", pins: f.config.promotion!.publish.initialSource! });
      expect(readState(f.updater.context).initialSourceJob).toBe(result.job!.id);
      expect(git(f.target, "rev-parse", "main")).toBe(commit);
      expect(git(f.target, "show", "--format=%P", "--no-patch", commit)).toBe(f.expectedMain);
      expect(git(f.target, "show", "--format=%B", "--no-patch", commit)).toContain(
        "Initial-Source-Basis: historical-replay",
      );
      expect(git(f.target, "show", "main:src/behavior.ts")).toBe("export const behavior = 2;");
    } else {
      expect(result.outcome).toBe("held");
      expect(result.job?.promotion?.status).toBe("held");
      expect(result.job?.promotion?.publication).toBeUndefined();
      expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
      expect(git(f.target, "for-each-ref", "--format=%(refname)", "refs/heads/dori-update/")).toBe("");
      expect(readState(f.updater.context).baseline).toBeUndefined();
      expect(readState(f.updater.context).initialSourceJob).toBeUndefined();
    }
  });
});

test("an initial-source approval never covers owner main movement before publication intent", async () => {
  const f = await bootstrapFixture("exact", false, exportHash);
  f.write(f.seed, "owner-history.txt", "later owner work outside the initial-source approval\n");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "Owner main advances after explicit source approval");
  const owner = git(f.seed, "rev-parse", "HEAD");
  git(f.seed, "push", f.target, "HEAD:refs/heads/main");
  const result = await f.updater.once();
  expect(result.outcome).toBe("held");
  expect(result.job?.promotion?.status).toBe("held");
  expect(result.job?.promotion?.publication).toBeUndefined();
  expect(git(f.target, "rev-parse", "main")).toBe(owner);
  expect(git(f.target, "show", "main:owner-history.txt")).toBe("later owner work outside the initial-source approval");
  expect(readState(f.updater.context).initialSourceJob).toBeUndefined();
});

test("initial-source resume retains its frozen basis when the live local source changes", async () => {
  const f = await bootstrapFixture("exact", false, exportHash);
  const interrupted = new Error("fixture stops after durable initial-source preparation");
  await expect(
    publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, (record) => {
      f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(record) };
      persistJob(f.job);
      if (record.status === "prepared") throw interrupted;
    }),
  ).rejects.toBe(interrupted);
  const basis = readJob(f.config.root, f.job.id).promotion!.publication!.basis;
  f.write(f.localSource, "src/behavior.ts", "export const behavior = 9;\n");
  const resumed = await f.updater.once();
  expect(resumed.outcome).toBe("promoted");
  expect(resumed.job?.promotion?.publication?.basis).toEqual(basis);
  expect(readState(f.updater.context).initialSourceJob).toBe(f.job.id);
  expect(git(f.target, "show", "main:src/behavior.ts")).toBe("export const behavior = 2;");
});

test("a claim-before-receipt interruption recovers only the same exact initial-source job", async () => {
  const f = await bootstrapFixture("exact", false, exportHash);
  const state = readState(f.updater.context);
  const interrupted = new Error("fixture stops before publication receipt is persisted");
  await expect(
    publishRelease(f.updater.context, state, f.job, undefined, () => {
      throw interrupted;
    }),
  ).rejects.toBe(interrupted);
  expect(readState(f.updater.context).initialSourceJob).toBe(f.job.id);
  const resumed = await publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, () => {});
  expect(resumed.record.status).toBe("published");
  expect(resumed.record.basis.kind).toBe("initial-source");
  expect(readState(f.updater.context).initialSourceJob).toBe(f.job.id);
});

test.each(["pins", "kind"] as const)("initial-source resume rejects a changed durable basis %s", async (field) => {
  const f = await bootstrapFixture("exact", false, exportHash);
  const state = readState(f.updater.context);
  let retained: PublicationRecord | undefined;
  const interrupted = new Error("fixture retains the initial-source decision before remote effects");
  await expect(
    publishRelease(f.updater.context, state, f.job, undefined, (record) => {
      retained = structuredClone(record);
      throw interrupted;
    }),
  ).rejects.toBe(interrupted);
  const original = retained!;
  if (original.basis.kind !== "initial-source") throw new Error("fixture did not retain its initial-source basis");
  const changed: PublicationRecord = {
    ...original,
    basis:
      field === "kind"
        ? { kind: "matched-main" }
        : { kind: "initial-source", pins: { ...original.basis.pins, exportHash: "0".repeat(64) } },
  };
  await expect(publishRelease(f.updater.context, state, f.job, changed, () => {})).rejects.toThrow("publication basis");
  expect(readState(f.updater.context).initialSourceJob).toBe(f.job.id);
  expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
  expect(git(f.target, "for-each-ref", "--format=%(refname)", "refs/heads/dori-update/")).toBe("");
});

test("a consumed initial-source exception stays bound to its original registered job", async () => {
  const f = await bootstrapFixture("exact", false, exportHash);
  const state = readState(f.updater.context);
  const previousJob = "f".repeat(64);
  state.jobs[f.job.baseUpstream] = previousJob;
  state.initialSourceJob = previousJob;
  persistState(f.updater.context, state);
  const result = await f.updater.once();
  expect(result.outcome).toBe("held");
  expect(result.job?.promotion?.publication).toBeUndefined();
  expect(result.job?.promotion?.status).toBe("held");
  expect(readState(f.updater.context).initialSourceJob).toBe(previousJob);
  expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
});

test("initial-source claims reject stale-state removal and malformed stored identities", async () => {
  const f = await publicationFixture();
  const state = readState(f.updater.context);
  state.initialSourceJob = f.job.id;
  persistState(f.updater.context, state);
  delete state.initialSourceJob;
  expect(() => persistState(f.updater.context, state)).toThrow("immutable");
  expect(readState(f.updater.context).initialSourceJob).toBe(f.job.id);
  saveJson(join(f.config.root, "state.json"), { ...state, initialSourceJob: "unrecognized-job" });
  expect(() => readState(f.updater.context)).toThrow("unrecognized initial-source job");
});

test("initial source admission accepts only complete exact five-pin configuration", async () => {
  const f = await publicationFixture();
  const file = join(f.directory, "initial-source.json");
  const initialSource = {
    main: f.expectedMain,
    sourceHash: f.job.inputs!.local.hash,
    exportHash: publicSource(f.job).hash,
    baseUpstream: f.job.baseUpstream,
    upstream: f.job.upstream,
  };
  const config = (value: unknown) => ({
    ...f.config,
    promotion: { publish: { ...f.config.promotion!.publish, initialSource: value } },
  });
  saveJson(file, config(initialSource));
  expect(loadUpdateConfig(file).promotion?.publish.initialSource).toEqual(initialSource);
  for (const value of [
    null,
    [],
    { main: initialSource.main, sourceHash: initialSource.sourceHash },
    { ...initialSource, main: "main" },
    { ...initialSource, sourceHash: "a".repeat(63) },
    { ...initialSource, exportHash: "A".repeat(64) },
    { ...initialSource, baseUpstream: "main" },
    { ...initialSource, upstream: "HEAD" },
    { ...initialSource, extra: true },
  ]) {
    saveJson(file, config(value));
    expect(() => loadUpdateConfig(file)).toThrow();
  }
});

test.each(["changed-claim", "unregistered"] as const)(
  "a %s admission holds before claiming initial source",
  async (kind) => {
    const f = await bootstrapFixture("exact", false, exportHash);
    const publisher = new PublicationProcess(f.config.promotion!.publish, join(f.job.directory, "publication"));
    await publisher.git(["init", "--bare", "--quiet"]);
    await publisher.git(["fetch", "--no-tags", "--", f.target, f.expectedMain]);
    const state = readState(f.updater.context);
    if (kind === "changed-claim") state.initialSourceJob = f.job.id;
    else delete state.jobs[f.job.upstream];
    await expect(
      publicationBasis(f.updater.context, state, publisher, f.job, publicSource(f.job), f.expectedMain),
    ).rejects.toBeInstanceOf(PublicationHold);
    expect(readState(f.updater.context).initialSourceJob).toBeUndefined();
    expect(readState(f.updater.context).jobs[f.job.upstream]).toBe(f.job.id);
    expect(readJob(f.config.root, f.job.id).promotion?.publication).toBeUndefined();
    expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
  },
);

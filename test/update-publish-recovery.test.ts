import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DoriUpdater } from "../src/update/controller.ts";
import { publishRelease } from "../src/update/publish.ts";
import type { PublicationRecord } from "../src/update/publish-types.ts";
import { persistJob, persistState, readJob, readState, saveJson } from "../src/update/state.ts";
import { git, publicationFixture } from "./update-setup.ts";

test("main movement after durable publication preparation holds without rebasing or overwriting owner history", async () => {
  const f = await publicationFixture();
  const commands = structuredClone(f.job.commands);
  const interrupted = new Error("fixture interruption after durable local preparation");
  await expect(
    publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, (record) => {
      f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(record) };
      persistJob(f.job);
      if (record.status === "prepared") throw interrupted;
    }),
  ).rejects.toBe(interrupted);
  const prepared = readJob(f.config.root, f.job.id).promotion!.publication!;
  expect(prepared.expectedMain).toBe(f.expectedMain);
  f.write(f.seed, "owner-history.txt", "concurrent owner change must survive\n");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "Concurrent owner main update");
  const owner = git(f.seed, "rev-parse", "HEAD");
  git(f.seed, "push", f.target, "HEAD:refs/heads/main");
  const result = await new DoriUpdater(f.config, () => {}).once();
  expect(result.outcome).toBe("held");
  expect(git(f.target, "rev-parse", "main")).toBe(owner);
  expect(git(f.target, "show", "--format=%P", "--no-patch", owner)).toBe(f.expectedMain);
  expect(git(f.target, "show", "main:owner-history.txt")).toBe("concurrent owner change must survive");
  expect(result.job?.phase).toBe("ready");
  expect(result.job?.commands).toEqual(commands);
  expect(result.job?.promotion?.publication?.status).toBe("held");
  expect(readState(f.updater.context).baseline).toBeUndefined();
  expect(existsSync(join(f.config.root, "detector", "last-detection.json"))).toBe(false);
  expect((await new DoriUpdater(f.config, () => {}).once()).outcome).toBe("duplicate");
  expect(git(f.target, "rev-parse", "main")).toBe(owner);
});

test("lost acknowledgement after actual main push resumes from intent and real refs before upstream dedup or paid work", async () => {
  const f = await publicationFixture();
  const commands = structuredClone(f.job.commands);
  const review = structuredClone(f.job.review);
  const history = structuredClone(f.job.history);
  const interrupted = new Error("fixture interruption before published receipt fsync");
  await expect(
    publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, (record) => {
      if (record.status === "published") throw interrupted;
      f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(record) };
      persistJob(f.job);
    }),
  ).rejects.toBe(interrupted);
  const persisted = readJob(f.config.root, f.job.id);
  const intent = persisted.promotion!.publication!;
  expect(intent.status).toBe("main-pushing");
  expect(intent.commit).toBe(git(f.target, "rev-parse", "main"));
  expect(git(f.target, "rev-parse", intent.branch)).toBe(intent.commit!);
  expect(readState(f.updater.context).baseline).toBeUndefined();
  const state = readState(f.updater.context);
  state.active = f.job.id;
  persistState(f.updater.context, state);
  saveJson(join(f.config.root, "controller.lock"), {
    version: 1,
    pid: 2147483647,
    host: hostname(),
    nonce: "stopped-publication-controller",
    at: new Date().toISOString(),
  });
  f.write(f.remote, "src/behavior.ts", "export const behavior = 3;\n");
  git(f.remote, "add", ".");
  git(f.remote, "commit", "-m", "Later upstream must wait behind interrupted promotion");
  const result = await new DoriUpdater(f.config, () => {}).once();
  expect(result.outcome).toBe("promoted");
  expect(result.job?.id).toBe(f.job.id);
  expect(result.job?.phase).toBe("ready");
  expect(result.job?.commands).toEqual(commands);
  expect(result.job?.review).toEqual(review);
  expect(result.job?.history).toEqual(history);
  expect(result.job?.promotion?.publication?.commit).toBe(intent.commit);
  expect(result.job?.promotion?.status).toBe("complete");
  expect(git(f.target, "rev-list", "--count", "main")).toBe("3");
  const resumed = readState(f.updater.context);
  expect(resumed.baseline).toBe(f.job.upstream);
  expect(resumed.active).toBeUndefined();
  expect(Object.keys(resumed.jobs)).toEqual([f.job.upstream]);
  expect(existsSync(join(f.config.root, "detector", "last-detection.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.config.root, "promotion-lock-recovery.json"), "utf8")).readyJob).toBe(f.job.id);
  expect(JSON.parse(readFileSync(join(f.job.directory, "report.json"), "utf8"))).toMatchObject({
    published: true,
    deployed: false,
  });
});

test("an actually moved owned candidate branch is held even when its main still matches", async () => {
  const f = await publicationFixture();
  const interrupted = new Error("fixture interruption after confirmed candidate push");
  await expect(
    publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, (record: PublicationRecord) => {
      f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(record) };
      persistJob(f.job);
      if (record.status === "awaiting-ci") throw interrupted;
    }),
  ).rejects.toBe(interrupted);
  const publication = readJob(f.config.root, f.job.id).promotion!.publication!;
  expect(git(f.target, "rev-parse", publication.branch)).toBe(publication.commit!);
  // A real server-side owner move after the controller's confirmed branch receipt.
  git(f.target, "update-ref", publication.branch, f.expectedMain, publication.commit!);
  expect((await new DoriUpdater(f.config, () => {}).once()).outcome).toBe("held");
  expect(git(f.target, "rev-parse", publication.branch)).toBe(f.expectedMain);
  expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
  expect(readState(f.updater.context).baseline).toBeUndefined();
});

test("two real controllers recovering one dead ready owner preserve a single public history", async () => {
  const f = await publicationFixture();
  const commands = structuredClone(f.job.commands);
  const state = readState(f.updater.context);
  state.active = f.job.id;
  persistState(f.updater.context, state);
  saveJson(join(f.config.root, "controller.lock"), {
    version: 1,
    pid: 2147483647,
    host: hostname(),
    nonce: "concurrent-stopped-ready-owner",
    at: new Date().toISOString(),
  });
  const config = join(f.directory, "updater.json");
  saveJson(config, f.config);
  const source = `import { runUpdate } from ${JSON.stringify(new URL("../src/update/cli.ts", import.meta.url).href)};
process.exit(await runUpdate(["check", "--config", ${JSON.stringify(config)}]));`;
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, "-e", source], {
      cwd: f.directory,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 20_000,
    }),
  );
  const codes = await Promise.all(children.map((child) => child.exited));
  expect(codes).toContain(0);
  expect(codes.every((code) => code === 0 || code === 2)).toBe(true);
  expect(git(f.target, "rev-list", "--count", "main")).toBe("3");
  expect(readJob(f.config.root, f.job.id).commands).toEqual(commands);
  expect(readState(f.updater.context).baseline).toBe(f.job.upstream);
  expect(existsSync(join(f.config.root, "controller.lock"))).toBe(false);
});

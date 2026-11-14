import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "../src/update/config.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { pendingPromotion } from "../src/update/promotion.ts";
import { publicSource } from "../src/update/publish-export.ts";
import { PublicationProcess } from "../src/update/publish-process.ts";
import { publishRelease } from "../src/update/publish.ts";
import { candidateReport, reportCandidate } from "../src/update/report.ts";
import { persistJob, persistState, readJob, readState } from "../src/update/state.ts";
import type { UpdateJob } from "../src/update/types.ts";
import { bootstrapFixture } from "./update-publish-setup.ts";
import { git, type PublicationFixture, publicationFixture } from "./update-setup.ts";

async function terminalCycles(f: PublicationFixture, held: UpdateJob) {
  expect(held.phase).toBe("ready");
  expect(held.sourceHash).toBe(f.job.sourceHash);
  expect(held.history).toEqual(f.job.history);
  expect(held.review).toEqual(f.job.review);
  expect(held.commands.filter((receipt) => receipt.name !== "notify")).toEqual(f.job.commands);
  expect(held.promotion?.status).toBe("held");
  expect(held.promotion?.notifications?.["promotion-held"]).toEqual({ state: "sent", exitCode: 0 });
  expect(candidateReport(f.updater.context, held)).toMatchObject({ ready: true, published: false });
  expect(readState(f.updater.context).active).toBeUndefined();
  expect(readState(f.updater.context).baseline).toBeUndefined();
  expect(pendingPromotion(f.updater.context, readState(f.updater.context))).toBeUndefined();
  const notifications = held.commands.filter((receipt) => receipt.name === "notify");
  expect(notifications).toHaveLength(1);
  expect(JSON.parse(readFileSync(notifications[0]!.stdout, "utf8"))).toMatchObject({
    outcome: "promotion-held",
    promotionStatus: "held",
    phase: "ready",
    candidateSourceHash: f.job.sourceHash,
  });
  await reportCandidate(f.updater.context, readJob(f.config.root, f.job.id));
  expect(f.events.filter((event) => event.job === f.job.id && event.event === "promotion-held")).toHaveLength(1);
  const retained = readFileSync(join(f.job.directory, "job.json"), "utf8");
  const report = readFileSync(join(f.job.directory, "report.json"), "utf8");
  for (let cycle = 0; cycle < 2; cycle++) {
    const duplicate = await new DoriUpdater(f.config, (event) => f.events.push(event)).once();
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.job?.id).toBe(f.job.id);
    expect(readFileSync(join(f.job.directory, "job.json"), "utf8")).toBe(retained);
    expect(readFileSync(join(f.job.directory, "report.json"), "utf8")).toBe(report);
  }
  f.write(f.remote, "src/behavior.ts", "export const behavior = 3;\n");
  git(f.remote, "add", ".");
  git(f.remote, "commit", "-m", "New upstream after terminal publication admission hold");
  const upstream = git(f.remote, "rev-parse", "HEAD");
  const next = await new DoriUpdater(f.config, (event) => f.events.push(event)).once();
  expect(next.job?.upstream).toBe(upstream);
  expect(next.job?.id).not.toBe(f.job.id);
  expect(next.job?.baseUpstream).toBe(f.config.baseUpstream);
  expect(next.job?.phase).toBe("failed"); // The real failing port command never impersonates a model.
  expect(readState(f.updater.context).observed).toBe(upstream);
  expect(readFileSync(join(f.job.directory, "job.json"), "utf8")).toBe(retained);
  expect(readFileSync(join(f.job.directory, "report.json"), "utf8")).toBe(report);
  expect(f.events.filter((event) => event.job === f.job.id && event.event === "promotion-held")).toHaveLength(1);
}

describe("terminal initial-source publication admission", () => {
  // Each case prepares two distinct real Git/fsync candidates, not two copies of the same reference fixture.
  // Give that integration lifecycle its own budget; runtime command deadlines and all assertions stay unchanged.
  const terminalCycleTimeoutMs = 20_000;
  let exportHash: string;
  beforeAll(async () => {
    // Share only the checked export hash; every terminal case retains its own candidate and durable state.
    exportHash = publicSource((await publicationFixture()).job).hash;
  });

  test.each(["source-mismatch", "main-mismatch", "export-mismatch", "base-mismatch", "upstream-mismatch"] as const)(
    "a %s pin admission becomes a durable notified hold and frees later upstream detection",
    async (binding) => {
      const f = await bootstrapFixture(binding, true, exportHash);
      expect(publicSource(f.job).hash).toBe(exportHash);
      const first = await f.updater.once();
      expect(first.outcome).toBe("held");
      expect(first.job?.promotion?.publication).toBeUndefined();
      expect(readState(f.updater.context).initialSourceJob).toBeUndefined();
      await terminalCycles(f, first.job!);
      expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
      expect(git(f.target, "for-each-ref", "--format=%(refname)", "refs/heads/dori-update/")).toBe("");
    },
    terminalCycleTimeoutMs,
  );

  test.each(["unapproved-tree", "approved-main"] as const)(
    "a changed %s holds once across controller restarts",
    async (kind) => {
      const f =
        kind === "approved-main"
          ? await bootstrapFixture("exact", true, exportHash)
          : await publicationFixture(() => ({
              reporter: {
                name: "notify",
                argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);", "{text}"],
                timeoutMs: 10_000,
              },
            }));
      expect(publicSource(f.job).hash).toBe(exportHash);
      f.write(f.seed, "owner-history.txt", "Owner content outside the frozen publication basis\n");
      git(f.seed, "add", ".");
      git(f.seed, "commit", "-m", "Owner main advanced before publication admission");
      const main = git(f.seed, "rev-parse", "HEAD");
      git(f.seed, "push", f.target, "HEAD:refs/heads/main");
      const first = await f.updater.once();
      expect(first.job?.promotion?.publication).toBeUndefined();
      await terminalCycles(f, first.job!);
      expect(git(f.target, "rev-parse", "main")).toBe(main);
      expect(git(f.target, "show", "main:owner-history.txt")).toBe(
        "Owner content outside the frozen publication basis",
      );
      expect(readState(f.updater.context).initialSourceJob).toBeUndefined();
    },
    terminalCycleTimeoutMs,
  );

  test.each(["basis", "intent", "deadline", "timestamp"] as const)(
    "a retained %s mismatch is terminal without re-admission or paid work",
    async (kind) => {
      const f = await bootstrapFixture("exact", true, exportHash);
      expect(publicSource(f.job).hash).toBe(exportHash);
      const interrupted = new Error("fixture interruption after the durable initial-source decision");
      await expect(
        publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, (record) => {
          f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(record) };
          persistJob(f.job);
          if (record.status === "prepared") throw interrupted;
        }),
      ).rejects.toBe(interrupted);
      const retained = readJob(f.config.root, f.job.id);
      const publication = retained.promotion!.publication!;
      retained.promotion!.publication =
        kind === "basis"
          ? { ...publication, basis: { kind: "matched-main" } }
          : kind === "intent"
            ? { ...publication, exportHash: "0".repeat(64) }
            : kind === "deadline"
              ? { ...publication, ciWait: { startedAt: publication.createdAt, deadlineAt: "not-a-date" } }
              : { ...publication, createdAt: "not-a-date" };
      persistJob(retained);
      const first = await f.updater.once();
      expect(first.job?.promotion?.problem).toContain(kind === "basis" ? "publication basis" : "publication intent");
      await terminalCycles(f, first.job!);
      expect(readState(f.updater.context).initialSourceJob).toBe(f.job.id);
      expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    },
    terminalCycleTimeoutMs,
  );

  test(
    "an initial-source exception owned by another durable job holds without stealing its claim",
    async () => {
      const f = await bootstrapFixture("exact", true, exportHash);
      expect(publicSource(f.job).hash).toBe(exportHash);
      const id = "f".repeat(64);
      const directory = join(f.config.root, "jobs", id);
      mkdirSync(directory);
      persistJob({
        ...f.job,
        id,
        directory,
        candidate: join(directory, "candidate"),
        promotion: { version: 1, status: "held", problem: "retained previous initial-source owner" },
      });
      const state = readState(f.updater.context);
      state.jobs[f.job.baseUpstream] = id;
      state.initialSourceJob = id;
      persistState(f.updater.context, state);
      const first = await f.updater.once();
      expect(first.job?.promotion?.problem).toContain("already claimed by another job");
      expect(first.job?.promotion?.publication).toBeUndefined();
      await terminalCycles(f, first.job!);
      expect(readState(f.updater.context).initialSourceJob).toBe(id);
      expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    },
    terminalCycleTimeoutMs,
  );
});

test("a transient pre-record remote operation retries the same ready job without a terminal notification", async () => {
  const f = await publicationFixture(() => ({
    reporter: {
      name: "notify",
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);", "{text}"],
      timeoutMs: 10_000,
    },
  }));
  const originalGit = PublicationProcess.prototype.git;
  let interrupted = false;
  const transport = spyOn(PublicationProcess.prototype, "git").mockImplementation(async function (
    this: PublicationProcess,
    argv,
    input,
    auth,
    env,
  ) {
    if (argv[0] === "ls-remote" && !interrupted) {
      interrupted = true;
      throw new UpdateError("transient remote ref read failure");
    }
    return originalGit.call(this, argv, input, auth, env);
  });
  try {
    const first = (await f.updater.once()).job!;
    expect(first.promotion).toMatchObject({ status: "publishing", problem: "transient remote ref read failure" });
    expect(first.promotion?.publication).toBeUndefined();
    expect(first.notification).toBeUndefined();
    expect(first.commands).toEqual(f.job.commands);
    expect(pendingPromotion(f.updater.context, readState(f.updater.context))?.id).toBe(f.job.id);
    const resumed = await new DoriUpdater(f.config, (event) => f.events.push(event)).once();
    expect(resumed.outcome).toBe("promoted");
    expect(resumed.job?.id).toBe(f.job.id);
    expect(resumed.job?.promotion?.status).toBe("complete");
    expect(resumed.job?.commands.filter((receipt) => receipt.name !== "notify")).toEqual(f.job.commands);
    expect(resumed.job?.review).toEqual(f.job.review);
    expect(resumed.job?.history).toEqual(f.job.history);
    const notifications = resumed.job!.commands.filter((receipt) => receipt.name === "notify");
    expect(notifications).toHaveLength(2);
    expect(notifications.map((receipt) => JSON.parse(readFileSync(receipt.stdout, "utf8")).outcome)).toEqual([
      "before-main-publication",
      "promoted",
    ]);
    expect(resumed.job!.preActionNotices?.["main-publication"]).toMatchObject({ state: "accepted", exitCode: 0 });
    expect(f.events.some((event) => event.event === "promotion-held")).toBe(false);
    expect(readState(f.updater.context).baseline).toBe(f.job.upstream);
  } finally {
    transport.mockRestore();
  }
});

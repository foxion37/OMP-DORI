import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DoriUpdater } from "../src/update/controller.ts";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { pendingPromotion } from "../src/update/promotion.ts";
import { publishRelease } from "../src/update/publish.ts";
import { candidateReport, persistReport } from "../src/update/report.ts";
import { persistJob, persistState, readJob, readState, saveJson } from "../src/update/state.ts";
import { git, publicationFixture } from "./update-setup.ts";

test("terminal held promotion retains its evidence and baseline while dedup permits a newer upstream SHA", async () => {
  const f = await publicationFixture();
  f.job.promotion = { version: 1, status: "held", problem: "terminal publication gate held" };
  persistJob(f.job);
  persistReport(f.updater.context, f.job);
  const state = readState(f.updater.context);
  state.baseline = f.config.baseUpstream;
  persistState(f.updater.context, state);
  const jobBefore = readFileSync(join(f.job.directory, "job.json"), "utf8");
  const reportBefore = readFileSync(join(f.job.directory, "report.json"), "utf8");
  const configHash = f.updater.context.configHash;
  expect(pendingPromotion(f.updater.context, state)).toBeUndefined();

  const duplicate = await new DoriUpdater(f.config, () => {}).once();
  expect(duplicate.outcome).toBe("duplicate");
  expect(duplicate.job?.id).toBe(f.job.id);
  expect(duplicate.job?.commands).toEqual(f.job.commands);
  expect(readFileSync(join(f.job.directory, "job.json"), "utf8")).toBe(jobBefore);

  f.write(f.remote, "src/behavior.ts", "export const behavior = 3;\n");
  git(f.remote, "add", ".");
  git(f.remote, "commit", "-m", "New upstream after terminal promotion hold");
  const upstream = git(f.remote, "rev-parse", "HEAD");
  const restarted = new DoriUpdater(f.config, () => {});
  const next = await restarted.once();
  expect(next.outcome).toBe("candidate");
  expect(next.job?.upstream).toBe(upstream);
  expect(next.job?.id).not.toBe(f.job.id);
  expect(next.job?.baseUpstream).toBe(f.config.baseUpstream);
  expect(next.job?.inputs?.baseUpstream).toBe(f.config.baseUpstream);
  expect(next.job?.phase).toBe("failed"); // The fixture's real failing port process never impersonates a model.
  expect(readState(restarted.context)).toMatchObject({
    baseline: f.config.baseUpstream,
    observed: upstream,
    jobs: { [f.job.upstream]: f.job.id, [upstream]: next.job!.id },
  });
  expect(readFileSync(join(f.job.directory, "job.json"), "utf8")).toBe(jobBefore);
  expect(readFileSync(join(f.job.directory, "report.json"), "utf8")).toBe(reportBefore);
  expect(restarted.context.configHash).toBe(configHash);
  expect(restarted.context.config.baseUpstream).toBe(f.config.baseUpstream);
  expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
  expect(git(f.target, "for-each-ref", "--format=%(refname)", "refs/heads/dori-update/")).toBe("");
});

test("published ancestor remains published while advanced owner main holds stale deployment before effects", async () => {
  const f = await publicationFixture((paths) => {
    const home = join(paths.directory, "operator-home");
    const doriHome = join(home, ".dori");
    const stateDir = join(doriHome, "state");
    const doriConfig = join(doriHome, "config.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    saveJson(doriConfig, { runtime: "herdr", stateDir, defaultCwd: paths.localSource });
    return {
      promotion: {
        publish: {
          remote: join(paths.directory, "publication.git"),
          ref: "refs/heads/main",
          author: { name: "Dori publication fixture", email: "publication@example.invalid" },
        },
        deployment: parseDeploymentConfig(
          {
            releaseRoot: join(paths.directory, "releases"),
            liveSource: paths.localSource,
            home,
            doriHome,
            doriConfig,
            stateDir,
            bun: process.execPath,
            omp: process.execPath,
            herdr: process.execPath,
            pane: "fixture:p1",
            sessionId: "00000000-0000-4000-8000-000000000001",
            model: "openai-codex/gpt-6.1-sol",
            restartLock: join(doriHome, "deployment.lock"),
            launcherPath: join(paths.directory, "bin", "managed-restart"),
            healthTimeoutMs: 100,
            stopTimeoutMs: 100,
          },
          paths.directory,
        ),
      },
    };
  });
  const commands = structuredClone(f.job.commands);
  const history = structuredClone(f.job.history);
  const review = structuredClone(f.job.review);
  const configHash = f.updater.context.configHash;
  await publishRelease(f.updater.context, readState(f.updater.context), f.job, undefined, (record) => {
    f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(record) };
    persistJob(f.job);
  });
  const published = readJob(f.config.root, f.job.id).promotion!.publication!;
  expect(published.status).toBe("published");
  git(f.seed, "fetch", f.target, "refs/heads/main");
  git(f.seed, "merge", "--ff-only", "FETCH_HEAD");
  f.write(f.seed, "owner-followup.txt", "owner main advanced after publication\n");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "Owner update after published release");
  const owner = git(f.seed, "rev-parse", "HEAD");
  git(f.seed, "push", f.target, "HEAD:refs/heads/main");

  const result = await f.updater.once();
  const job = result.job!;
  expect(result.outcome).toBe("held");
  expect(job.phase).toBe("ready");
  expect(job.sourceHash).toBe(f.job.sourceHash);
  expect(job.commands).toEqual(commands);
  expect(job.history).toEqual(history);
  expect(job.review).toEqual(review);
  expect(job.promotion).toMatchObject({
    status: "held",
    publication: { status: "published", commit: published.commit },
  });
  expect(job.promotion?.problem).toContain("published main changed");
  expect(job.promotion?.deployment).toBeUndefined();
  expect(existsSync(f.config.promotion!.deployment!.releaseRoot)).toBe(false);
  expect(existsSync(join(f.config.root, "detector", "last-detection.json"))).toBe(false);
  expect(readState(f.updater.context).baseline).toBeUndefined();
  expect(readState(f.updater.context).active).toBeUndefined();
  expect(git(f.target, "rev-parse", "main")).toBe(owner);
  expect(f.updater.context.configHash).toBe(configHash);
  expect(candidateReport(f.updater.context, job)).toMatchObject({
    ready: true,
    candidateOnly: false,
    published: true,
    deployed: false,
  });
});

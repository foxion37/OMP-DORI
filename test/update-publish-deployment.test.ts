import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runUpdate } from "../src/update/cli.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { candidateReport } from "../src/update/report.ts";
import { readState, saveJson } from "../src/update/state.ts";
import { git, publicationFixture } from "./update-setup.ts";

test("real publication followed by an admitted deployment preparation failure retains the effective baseline", async () => {
  const f = await publicationFixture((paths) => {
    const home = join(paths.directory, "operator-home");
    const doriHome = join(home, ".dori");
    const stateDir = join(doriHome, "state");
    const doriConfig = join(doriHome, "config.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    saveJson(doriConfig, { runtime: "herdr", stateDir, defaultCwd: paths.localSource });
    const deployment = parseDeploymentConfig(
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
    );
    return {
      promotion: {
        publish: {
          remote: join(paths.directory, "publication.git"),
          ref: "refs/heads/main",
          author: { name: "Dori publication fixture", email: "publication@example.invalid" },
        },
        deployment,
      },
    };
  });
  const commands = structuredClone(f.job.commands);
  // This real source fixture lacks the frozen release package/lock set. No native process is invented or stopped.
  const result = await f.updater.once();
  expect(result.outcome).toBe("held");
  const job = result.job!;
  const publication = job.promotion!.publication!;
  expect(publication.status).toBe("published");
  expect(git(f.target, "rev-parse", "main")).toBe(publication.commit!);
  expect(git(f.target, "show", "--format=%P", "--no-patch", publication.commit!)).toBe(f.expectedMain);
  expect(job.phase).toBe("ready");
  expect(job.commands).toEqual(commands);
  expect(job.promotion?.status).toBe("held");
  expect(job.promotion?.deployment).toBeDefined();
  expect(job.promotion?.deployment?.status).not.toBe("healthy");
  expect(readState(f.updater.context).baseline).toBeUndefined();
  expect(f.updater.context.config.baseUpstream).toBe(f.config.baseUpstream);
  expect(candidateReport(f.updater.context, job)).toMatchObject({
    ready: true,
    candidateOnly: false,
    published: true,
    deployed: false,
    activationRequiresNewOwnerApproval: false,
  });
  const retried = await new DoriUpdater(f.config, () => {}).once();
  expect(retried.outcome).toBe("duplicate");
  expect(retried.job?.commands).toEqual(commands);
  expect(git(f.target, "rev-list", "--count", "main")).toBe("3");
  expect(readState(f.updater.context).baseline).toBeUndefined();
  const config = join(f.directory, "updater.json");
  saveJson(config, f.config);
  expect(await runUpdate(["check", "--config", config])).toBe(3);
});

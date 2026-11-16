import { expect, test } from "bun:test";
import { procCmdline } from "../src/update/proc.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DoriUpdater } from "../src/update/controller.ts";
import { deployRelease } from "../src/update/deployment.ts";
import { capturePointer, ownReleaseRoot, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { captureRuntime } from "../src/update/deployment-native.ts";
import { prepareRelease } from "../src/update/deployment-prepare.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { reportPreAction } from "../src/update/pre-action-notice.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { persistJob, readJob } from "../src/update/state.ts";
import type { UpdateJob } from "../src/update/types.ts";
import { foregroundFixture } from "./update-deploy-foreground-setup.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";
import { recordingReporter, waitFor } from "./update-pre-action-setup.ts";
import { fixture } from "./update-setup.ts";

async function forwardFixture(mode: "accepted" | "failed" | "ambiguous") {
  const f = fixture();
  const prepared = preparationFixture();
  const native = await foregroundFixture();
  const sink = recordingReporter(f.directory, mode);
  const tools = join(f.directory, "tools");
  mkdirSync(tools);
  const bun = join(tools, "bun");
  const herdr = join(tools, "herdr");
  writeFileSync(bun, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(tools, "ps"),
    `#!/bin/sh\nTZ=${JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone)} exec ${Bun.which("ps", { PATH: "/usr/bin:/bin" })} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    herdr,
    `#!${process.execPath}
const operation = process.argv[5];
const result = operation === "get"
  ? { pane: { agent: "omp", agent_status: "idle" } }
  : operation === "process-info" ? { process_info: ${JSON.stringify(native.front)} } : undefined;
if (!result) process.exit(70);
process.stdout.write(JSON.stringify({ result }));
`,
    { mode: 0o755 },
  );
  const config = {
    ...prepared.config,
    bun,
    herdr,
    omp: native.config.omp,
    liveSource: prepared.candidate,
    stateDir: native.config.stateDir,
    pane: native.config.pane,
    sessionId: native.config.sessionId,
    herdrSession: native.config.herdrSession!,
    monitorBootstrapFile: native.config.monitorBootstrapFile,
    shims: [],
    stopTimeoutMs: 150,
  };
  const ctx = new DoriUpdater({ ...f.config, reporter: sink.command }, () => {}).context;
  const id = digest(`${ctx.configHash}\n${prepared.input.commit}`);
  const directory = join(ctx.config.root, "jobs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const candidate = join(directory, "candidate");
  symlinkSync(prepared.candidate, candidate, "dir");
  const at = new Date().toISOString();
  const transaction = randomUUID();
  const record: DeploymentRecord = {
    version: 1,
    id: transaction,
    inputHash: digest(JSON.stringify(prepared.input)),
    configHash: digest(JSON.stringify(config)),
    commit: prepared.input.commit,
    tree: prepared.input.tree,
    sourceHash: prepared.input.sourceHash,
    releasePath: join(
      config.releaseRoot,
      "releases",
      `${prepared.input.commit}-${prepared.input.sourceHash.slice(0, 16)}`,
    ),
    directory: join(config.releaseRoot, "transactions", transaction),
    createdAt: at,
    status: "prepared",
    step: "prepare",
    oldRuntime: await captureRuntime(native.config, native.cli),
    oldSource: prepared.candidate,
    oldSourceHash: sourceManifest(prepared.candidate).hash,
    oldMonitors: native.bootstrap.running!.map(({ name, identity }) => ({
      ...identity!,
      name,
      argv: procCmdline(identity!.pid).split("\0").filter(Boolean),
    })),
    monitors: native.bootstrap,
    bootstrap: true,
  };
  ownReleaseRoot(config);
  await prepareRelease(config, prepared.input, record);
  record.preparedAt = new Date().toISOString();
  record.pointers = [
    capturePointer(config.liveSource, record.releasePath, transaction),
    capturePointer(config.launcherPath, join(record.directory, "managed-restart.sh"), transaction),
  ];
  const job: UpdateJob = {
    version: 1,
    id,
    upstream: prepared.input.commit,
    baseUpstream: f.config.baseUpstream,
    configHash: ctx.configHash,
    createdAt: at,
    updatedAt: at,
    directory,
    candidate,
    sourceHash: prepared.input.sourceHash,
    phase: "ready",
    commands: [],
    history: [{ phase: "ready", at }],
    promotion: { version: 1, status: "deploying", deployment: record },
  };
  saveDeploymentJson(join(record.directory, "deployment.json"), record);
  persistJob(job);
  const run = (interruptAfterNotice = false) => {
    const resumed = readJob(ctx.config.root, id);
    return deployRelease(
      config,
      prepared.input,
      resumed.promotion!.deployment,
      (value) => {
        if (value.stopRequestedAt) {
          expect(readJob(ctx.config.root, id).preActionNotices!["dori-replacement"]).toMatchObject({
            state: "accepted",
            exitCode: 0,
          });
        }
        resumed.promotion!.deployment = structuredClone(value);
        persistJob(resumed);
      },
      undefined,
      async (deployment) => {
        await reportPreAction(ctx, resumed, { action: "dori-replacement", deployment });
        if (interruptAfterNotice) throw new Error("fixture interruption after accepted notice and before native stop");
      },
    );
  };
  return { config, ctx, id, native, sink, run };
}

test
  .skipIf(process.platform !== "linux" && process.platform !== "darwin")
  .each(["accepted", "failed", "ambiguous"] as const)(
  "forward stop awaits its configured reporter and retains its exact notice across failures: %s",
  async (mode) => {
    const f = await forwardFixture(mode);
    const pending = f.run(mode === "accepted");
    try {
      await waitFor(() => existsSync(f.sink.started));
      expect(sameProcess(f.native.runtime)).toBe(true);
      expect(existsSync(f.native.signalPath)).toBe(false);
      const sending = readJob(f.ctx.config.root, f.id);
      expect(sending.promotion!.deployment!.stopRequestedAt).toBeUndefined();
      expect(f.sink.attempts()).toMatchObject([
        {
          outcome: "before-dori-replacement",
          job: f.id,
          deploymentIntent: sending.promotion!.deployment!.id,
          publicationCommit: sending.promotion!.deployment!.commit,
        },
      ]);
      if (mode === "accepted") {
        expect(sending.preActionNotices!["dori-replacement"]!.state).toBe("sending");
        expect(f.sink.delivered()).toEqual([]);
        f.sink.release();
      }
      const first = await pending;
      const retained = readJob(f.ctx.config.root, f.id);
      expect(retained.preActionNotices!["dori-replacement"]!.state).toBe(mode);
      if (mode === "accepted") {
        expect(first.stopRequestedAt).toBeUndefined();
        expect(sameProcess(f.native.runtime)).toBe(true);
        expect(existsSync(f.native.signalPath)).toBe(false);
        const repeated = await f.run();
        // This real native fixture records TERM without exiting, so the signal proves the forward effect.
        expect(repeated.stopRequestedAt).toBeString();
        expect(readFileSync(f.native.signalPath, "utf8")).toContain("SIGTERM");
        expect(f.sink.delivered()).toHaveLength(1);
      } else {
        expect(first).toMatchObject({ status: "held", step: "prepare" });
        expect(first.stopRequestedAt).toBeUndefined();
        expect(first.launchRequestedAt).toBeUndefined();
        expect(sameProcess(f.native.runtime)).toBe(true);
        expect(existsSync(f.native.signalPath)).toBe(false);
        const repeated = await f.run();
        expect(repeated.status).toBe("held");
        expect(repeated.stopRequestedAt).toBeUndefined();
        expect(sameProcess(f.native.runtime)).toBe(true);
        expect(existsSync(f.native.signalPath)).toBe(false);
        expect(f.sink.delivered()).toEqual([]);
      }
      expect(f.sink.attempts()).toHaveLength(1);
    } finally {
      f.sink.release();
      await pending;
    }
  },
  30_000,
);

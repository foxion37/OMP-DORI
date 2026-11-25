import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { defaultConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { HeadlessRuntime } from "../src/runtime/headless.ts";
import { readPrivate } from "../src/runtime/headless-record.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { Store } from "../src/store.ts";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { startHarness } from "../src/update/deployment-harness.ts";
import { actorEnv } from "../src/update/deployment-process.ts";
import type {
  DeploymentConfig,
  DeploymentInput,
  DeploymentRecord,
  ToolchainReceipt,
} from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { installNativeHost } from "./fixtures/native-host.ts";
import { desiredPath, intakeMonitor, leadHealthWriter, writeFakeOmp } from "./update-deploy-headless-lead.ts";
import { release, repoCli, until } from "./update-headless-lead-setup.ts";

// Headless lanes admit only the native OMP this checkout binds.
const nativeVersion: string = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../native-omp.lock"), "utf8"),
).nativeVersion;

type Inventory = {
  readonly roles: Readonly<Record<string, { readonly ref: SessionRef; readonly sessionId?: string }>>;
};

/**
 * A Cataly home whose native harness runs the fake headless OMP host. Short `/tmp` paths keep the broker sockets within
 * the Unix socket limit. `healthy(source)` decides whether the stand-in extension reports converged health for a lead
 * loaded from that source; the real extension writes the same runtime health receipt. Each lead runs a default intake
 * monitor named by its session's desired manifest; a `prelude` replaces it and the caller owns the monitors and their
 * manifest. `prelude` runs inside each lead process before its host starts, and `onLead` sees every live lead the health
 * writer observes. With `previousMain`, a lead loaded from the old release writes the previous main's health shape.
 */
export async function headlessDeployment(
  options: {
    readonly start?: boolean;
    readonly healthy?: (source: string) => boolean;
    readonly prelude?: string;
    readonly onLead?: (lead: { readonly sessionId: string; readonly pid: number }) => void;
    readonly previousMain?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync("/tmp/cdh-"));
  const omp = join(root, "h/omp-bin/omp");
  const sessions = join(root, "sessions");
  const config: DeploymentConfig = parseDeploymentConfig(
    {
      releaseRoot: "m",
      liveSource: "h/c/src",
      home: "h",
      catalyHome: "h/c",
      catalyConfig: "h/c/config.json",
      stateDir: "h/c/s",
      bun: process.execPath,
      omp,
      restartLock: "h/c/restart.lock",
      launcherPath: "h/c/bin/managed-restart",
      healthTimeoutMs: 5_000,
      stopTimeoutMs: 10_000,
    },
    root,
  );
  const work = join(config.home, "work");
  for (const dir of [config.stateDir, join(config.stateDir, "activity"), work, join(root, "h/omp-bin"), sessions])
    mkdirSync(dir, { recursive: true });
  // Every release here runs this checkout's CLI, so `harness up` (with the deployment's allowlisted environment) finds
  // the host where installs keep it. Preparation's same-commit tree binary is covered by update-deploy-native.test.ts.
  installNativeHost(config.catalyHome);
  const monitor = options.prelude === undefined ? intakeMonitor(root, config, work) : undefined;
  writeFakeOmp(omp, sessions, nativeVersion, options.prelude ?? monitor!.prelude);
  writeFileSync(
    config.catalyConfig,
    JSON.stringify({
      ...defaultConfig(config.catalyHome),
      stateDir: config.stateDir,
      defaultCwd: work,
      defaultModel: "fixture/initial",
      agentCommand: [omp, "--model", "{model}", "{prompt}"],
    }),
  );
  // Both loop controllers start and stay registered, but their passes are paused for a quiet harness.
  const store = new Store(config.catalyHome);
  store.setStop(Date.now(), "deployment fixture", "loop");
  store.setStop(Date.now(), "deployment fixture", "duty");

  ownReleaseRoot(config);
  const nativeConfig = join(config.releaseRoot, "native-config.json");
  writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
  const oldSource = join(config.releaseRoot, "releases", "previous");
  release(oldSource, "previous");
  symlinkSync(oldSource, config.liveSource);
  const candidate = join(root, "candidate");
  release(candidate, "next");
  const manifest = sourceManifest(candidate);
  const input: DeploymentInput = {
    remote: root,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: manifest.hash,
    candidate,
    publicManifest: manifest,
  };
  const newSource = join(config.releaseRoot, "releases", `${input.commit}-${input.sourceHash.slice(0, 16)}`);
  release(newSource, "next");
  // The configured executable's receipt, pinned to the new release's extension as preparation leaves it.
  const toolchain: ToolchainReceipt = {
    omp,
    bun: process.execPath,
    nativeVersion,
    ompEntry: realpathSync(omp),
    ompEntryHash: digest(readFileSync(omp)),
    bunHash: digest(readFileSync(process.execPath)),
    nativeConfig,
    nativeConfigHash: digest(readFileSync(nativeConfig)),
    nativeOverride: true,
    extensionSource: newSource,
  };
  const id = crypto.randomUUID();
  // Prepared exactly as `prepareRelease` leaves it: the published clone and its native toolchain receipt.
  const record: DeploymentRecord = {
    version: 1,
    id,
    inputHash: digest(JSON.stringify(input)),
    configHash: digest(JSON.stringify(config)),
    commit: input.commit,
    tree: input.tree,
    sourceHash: input.sourceHash,
    releasePath: newSource,
    directory: join(config.releaseRoot, "transactions", id),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
    preparedAt: new Date().toISOString(),
    toolchain,
  };

  const rt = new HeadlessRuntime(config.stateDir, actorEnv(config));
  const inventory = () => readPrivate<Inventory>(join(config.catalyHome, "harness-native.json"));
  const lead = async () => {
    const binding = inventory()?.roles["lead"];
    if (!binding?.sessionId) return undefined;
    const seen = await rt.observe(binding.ref);
    return seen.sessionId === binding.sessionId && seen.pid !== undefined ? { ...seen, pid: seen.pid } : undefined;
  };
  const stopWriter = leadHealthWriter({
    config,
    binding: () => inventory()?.roles["lead"],
    lead,
    healthy: options.healthy ?? (() => true),
    ...(monitor ? { manifest: monitor.manifest } : {}),
    ...(options.onLead ? { onLead: options.onLead } : {}),
    ...(options.previousMain ? { previousMain: (source: string) => source === oldSource } : {}),
  });

  if (options.start !== false) {
    await startHarness(config, oldSource, { ...toolchain, extensionSource: oldSource }, work);
    await until(async () => {
      const seen = await lead();
      const desired = !monitor || (seen?.sessionId && existsSync(desiredPath(config, seen.sessionId)));
      return seen?.status === "idle" && desired ? seen : undefined;
    }, "an idle lead with its desired monitors");
  }

  /** Settle every remaining native session through the harness, then remove the fixture tree. */
  const teardown = async (): Promise<void> => {
    await stopWriter();
    for (const info of await rt.list().catch(() => [])) {
      const seen = await rt.observe(info.ref).catch(() => undefined);
      if (!seen?.sessionId) continue;
      for (const dialog of seen.dialogs)
        await rt.answer(info.ref, dialog.id, { cancelled: true }, seen.sessionId).catch(() => undefined);
      // Harness roles refuse remote interrupts; a fixture background turn ends through its done file.
      if (seen.status === "working" && seen.pid !== undefined)
        writeFileSync(join(sessions, `${seen.harnessRole}-${seen.pid}.background-done`), "");
    }
    const stop = Bun.spawn([process.execPath, repoCli, "stop"], {
      cwd: config.home,
      env: actorEnv(config),
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
    });
    await stop.exited;
    for (const info of await rt.list().catch(() => [])) {
      const seen = await rt.observe(info.ref).catch(() => undefined);
      const role = seen?.harnessRole;
      if (role) await rt.stopHarnessRole(info.ref, role, seen.sessionId).catch(() => undefined);
      else await rt.close(info.ref).catch(() => undefined);
      if (seen?.pid !== undefined) {
        try {
          process.kill(seen.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  };

  /** End the lead's "background job" turn: the fake host settles on its next state read. */
  const settle = (pid: number): void => writeFileSync(join(sessions, `lead-${pid}.background-done`), "");
  return {
    root,
    config,
    input,
    record,
    toolchain,
    oldSource,
    newSource,
    work,
    rt,
    inventory,
    lead,
    until,
    settle,
    teardown,
  };
}

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { launchedProcess } from "../src/update/deployment-launch.ts";
import { DeploymentHeld, processIdentity } from "../src/update/deployment-process.ts";
import type { DeploymentRecord, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

posix("launched process chronology allows only the two-second ps precision window", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-deploy-identity-"));
  directories.push(root);
  const config = parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "home/.dori/src",
      home: "home",
      doriHome: "home/.dori",
      doriConfig: "home/.dori/config.json",
      stateDir: "home/.dori/state",
      bun: process.execPath,
      omp: process.execPath,
      herdr: process.execPath,
      pane: "w1:p1",
      sessionId: "same-session",
      model: "openai-codex/gpt-6.1-sol",
      restartLock: "home/.dori/restart.lock",
      launcherPath: "home/.dori/bin/restart",
      healthTimeoutMs: 100,
      quiesceCheckpointFile: "quiesce.json",
    },
    root,
  );
  const runtime: RuntimeIdentity = {
    ...processIdentity(process.pid)!,
    role: "dori",
    pane: config.pane,
    sessionId: config.sessionId,
    sessionFile: join(root, "existing-session.jsonl"),
    startedAt: new Date().toISOString(),
    cwd: root,
  };
  const record: DeploymentRecord = {
    version: 1,
    id: "intended-deployment",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    releasePath: join(root, "release"),
    directory: join(root, "transaction"),
    createdAt: new Date().toISOString(),
    status: "prepared",
    step: "prepare",
  };
  const f = { root, config, runtime, record };
  const nativeConfig = join(f.root, "clock-config.json");
  writeFileSync(nativeConfig, "{}");
  const imageHash = digest(readFileSync(f.config.bun));
  f.record.oldRuntime = f.runtime;
  f.record.toolchain = {
    omp: f.config.omp,
    bun: f.config.bun,
    nativeVersion: Bun.version,
    ompEntry: realpathSync(f.config.omp),
    ompEntryHash: imageHash,
    bunHash: imageHash,
    nativeConfig,
    nativeConfigHash: digest("{}"),
  };
  f.record.oldToolchain = f.record.toolchain;
  // Keep a harmless child alive while exercising its real /proc identity, image and argv.
  const argv = [
    process.execPath,
    "-e",
    'console.log("ready"); await Bun.stdin.text();',
    "--",
    `--resume=${f.runtime.sessionFile}`,
    "--dori-role",
    "dori",
    "--model",
    f.config.model,
    "--config",
    nativeConfig,
  ];
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    const identity = processIdentity(child.pid);
    expect(identity).toBeDefined();
    const since = "2026-11-12T01:31:06.070Z";
    // The observed KST lstart is 01:31:05Z; toString keeps this instant independent of the test host's timezone.
    const coarseStart = new Date("2026-11-12T01:31:05.000Z").toString();
    let psStart = coarseStart;
    const cli = herdrDeploymentCli(async (cmd, args) => {
      if (cmd === "herdr") {
        expect(args).toEqual(["--session", "clock-guard", "pane", "process-info", "--pane", f.config.pane]);
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              process_info: {
                shell_pid: process.pid,
                foreground_process_group_id: child.pid,
                foreground_processes: [{ pid: child.pid, name: "bun", argv }],
              },
            },
          }),
          stderr: "",
        };
      }
      expect(cmd).toBe("ps");
      expect(args).toEqual(["-o", "lstart=", "-p", String(child.pid)]);
      return { code: 0, stdout: `${psStart}\n`, stderr: "" };
    }, "clock-guard");
    for (const prior of [false, true]) {
      expect(await launchedProcess(f.config, cli, f.record, since, prior)).toEqual(identity);
      expect(await launchedProcess(f.config, cli, f.record, "2026-11-12T01:31:07.000Z", prior)).toEqual(identity);
      await expect(launchedProcess(f.config, cli, f.record, "2026-11-12T01:31:07.001Z", prior)).rejects.toThrow(
        DeploymentHeld,
      );
      psStart = new Date("2026-11-12T01:31:03.000Z").toString();
      await expect(launchedProcess(f.config, cli, f.record, since, prior)).rejects.toThrow(DeploymentHeld);
      psStart = "malformed process start";
      await expect(launchedProcess(f.config, cli, f.record, since, prior)).rejects.toThrow(DeploymentHeld);
      psStart = coarseStart;
      await expect(launchedProcess(f.config, cli, f.record, "malformed journal time", prior)).rejects.toThrow(
        DeploymentHeld,
      );
    }
  } finally {
    child.stdin.end();
    await child.exited;
  }
});

test
  .skipIf(process.platform !== "linux" && process.platform !== "darwin")
  .each(["Etc/UTC", "America/New_York", "Asia/Seoul"])(
  "native ps observation preserves the caller's %s epoch without inheriting its environment",
  async (timezone) => {
    const root = mkdtempSync(join(tmpdir(), "dori-observer-zone-"));
    directories.push(root);
    const observer = join(root, "observer.ts");
    writeFileSync(
      observer,
      `import { nativeCli } from ${JSON.stringify(new URL("../src/update/deployment-native.ts", import.meta.url).href)};
const config = ${JSON.stringify(deploymentConfig(root))};
const expectedStart = Date.now() - process.uptime() * 1_000;
const result = await nativeCli(config).exec("ps", ["-o", "lstart=", "-p", String(process.pid)]);
console.log(JSON.stringify({
  timezone: process.env.TZ, code: result.code, observedStart: Date.parse(result.stdout.trim()), expectedStart,
}));
`,
    );
    const child = Bun.spawn([process.execPath, observer], {
      env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8", TZ: timezone },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const observed = JSON.parse(stdout) as {
      timezone: string;
      code: number;
      observedStart: number;
      expectedStart: number;
    };
    expect(observed.timezone).toBe(timezone);
    expect(observed.code).toBe(0);
    expect(Number.isFinite(observed.observedStart)).toBe(true);
    expect(Math.abs(observed.observedStart - observed.expectedStart)).toBeLessThan(2_000);
  },
);

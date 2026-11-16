import { expect, test } from "bun:test";
import { procCmdline } from "../src/update/proc.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { launchedProcess, stopLaunchedProcess } from "../src/update/deployment-launch.ts";
import { requireShell } from "../src/update/deployment-native.ts";
import { processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { foregroundCli } from "./update-deploy-foreground-cli.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix("an owned no-shell bad startup stops before any role or health writer exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-uninitialized-"));
  const config = { ...deploymentConfig(root), omp: join(root, "omp"), bun: process.execPath, stopTimeoutMs: 2_000 };
  ownReleaseRoot(config);
  const nativeConfig = join(config.releaseRoot, "native-config.json");
  writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
  const signalled = join(root, "signalled");
  writeFileSync(
    config.omp,
    `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalled)}, "SIGTERM"); process.exit(0); });
console.log(JSON.stringify({ pid: process.pid }));
await Bun.stdin.text();
`,
  );
  const shell = spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
    cwd: root,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = once(shell, "exit");
  const lines = createInterface({ input: shell.stdout! });
  const ready = once(lines, "line");
  const since = new Date().toISOString();
  const sessionFile = join(root, "preserved-session.jsonl");
  const argv = [
    process.execPath,
    config.omp,
    "--config",
    nativeConfig,
    `--resume=${sessionFile}`,
    "--dori-role",
    "dori",
    "--model",
    config.model,
  ];
  shell.stdin!.write(`set -m\n${argv.map((arg) => JSON.stringify(arg)).join(" ")}\n`);
  const [line] = await ready;
  lines.close();
  const { pid } = JSON.parse(String(line)) as { pid: number };
  try {
    const expected = processIdentity(pid)!;
    const record: DeploymentRecord = {
      version: 1,
      id: "uninitialized-native-start",
      inputHash: "input",
      configHash: "config",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      sourceHash: "c".repeat(64),
      releasePath: join(root, "release"),
      directory: join(root, "transaction"),
      createdAt: since,
      status: "starting",
      step: "start",
      launchRequestedAt: since,
      oldRuntime: {
        ...processIdentity(process.pid)!,
        role: "dori",
        pane: config.pane,
        sessionId: config.sessionId,
        sessionFile,
        startedAt: since,
        cwd: root,
      },
      toolchain: {
        omp: config.omp,
        ompEntry: realpathSync(config.omp),
        ompEntryHash: digest(readFileSync(config.omp)),
        bun: config.bun,
        bunHash: digest(readFileSync(config.bun)),
        nativeVersion: "18.18.8",
        nativeConfig,
        nativeConfigHash: digest(readFileSync(nativeConfig)),
      },
    };
    const cli = foregroundCli(config, () => {
      const live = sameProcess(expected);
      const foregroundPid = live ? pid : shell.pid!;
      return {
        status: "idle",
        front: {
          shell_pid: shell.pid!,
          foreground_process_group_id: foregroundPid,
          foreground_processes: [
            {
              pid: foregroundPid,
              name: live ? "bun" : "bash",
              argv: procCmdline(foregroundPid).split("\0").filter(Boolean),
            },
          ],
        },
      };
    });
    expect(existsSync(join(config.stateDir, "sessions", `${encodeURIComponent(config.pane)}.json`))).toBe(false);
    expect(existsSync(join(config.stateDir, "runtime", `${encodeURIComponent(config.pane)}.json`))).toBe(false);
    expect(await launchedProcess(config, cli, record, since)).toEqual(expected);
    await stopLaunchedProcess(config, cli, record, since, expected);
    expect(sameProcess(expected)).toBe(false);
    expect(readFileSync(signalled, "utf8")).toBe("SIGTERM");
    await requireShell(config, cli);
  } finally {
    shell.stdin!.end();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

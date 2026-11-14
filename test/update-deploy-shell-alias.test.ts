import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { launchRuntime } from "../src/update/deployment-launch.ts";
import { DeploymentHeld, processIdentity, sameProcess, underProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { foregroundCli } from "./update-deploy-foreground-cli.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function shellAliasFixture(otherImage?: string) {
  const root = mkdtempSync(join(tmpdir(), "dori-shell-alias-"));
  const config = { ...deploymentConfig(root), omp: join(root, "omp"), bun: process.execPath };
  ownReleaseRoot(config);
  const nativeConfig = join(config.releaseRoot, "native-config.json");
  writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
  const effect = join(root, "native-started");
  writeFileSync(effect, "");
  writeFileSync(
    config.omp,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const started = { pid: process.pid, argv: process.argv };
writeFileSync(${JSON.stringify(effect)}, JSON.stringify(started));
console.log(JSON.stringify(started));
await Bun.stdin.text();
`,
    { mode: 0o700 },
  );
  const ready = join(root, "root-ready");
  writeFileSync(ready, "");
  const alias = join(root, "sh");
  if (otherImage) symlinkSync(otherImage, alias);
  const shell = spawn(
    otherImage ? "/bin/bash" : "/bin/sh",
    otherImage ? ["--noprofile", "--norc", "-c", 'exec -a /bin/sh "$1" -i', "root", alias] : ["-i"],
    {
      cwd: root,
      detached: true,
      env: { HOME: root, PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const exited = once(shell, "exit");
  cleanups.push(async () => {
    shell.stdin!.end();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  const watcher = watch(ready);
  try {
    const changed = once(watcher, "change");
    shell.stdin!.write(`printf ready > ${JSON.stringify(ready)}\n`);
    await changed;
  } finally {
    watcher.close();
  }
  const identity = processIdentity(shell.pid!)!;
  const sessionFile = join(root, "preserved-session.jsonl");
  const record: DeploymentRecord = {
    version: 1,
    id: "canonical-root-shell",
    inputHash: "input",
    configHash: "config",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceHash: "c".repeat(64),
    releasePath: join(root, "release"),
    directory: join(root, "transaction"),
    createdAt: new Date().toISOString(),
    status: "starting",
    step: "start",
    oldRuntime: {
      ...processIdentity(process.pid)!,
      role: "dori",
      pane: config.pane,
      sessionId: config.sessionId,
      sessionFile,
      startedAt: new Date().toISOString(),
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
  const cli = foregroundCli(
    config,
    () => {
      const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
      return {
        status: "idle",
        front: {
          shell_pid: identity.pid,
          foreground_process_group_id: Number(stat[2]),
          foreground_processes: [
            {
              pid: identity.pid,
              name: readFileSync(`/proc/${identity.pid}/comm`, "utf8").trim(),
              argv: readFileSync(`/proc/${identity.pid}/cmdline`, "utf8").split("\0").filter(Boolean),
            },
          ],
        },
      };
    },
    (line) => {
      shell.stdin!.write(`${line}\n`);
    },
  );
  return { root, config, record, cli, identity, effect, stdout: shell.stdout! };
}

const linux = test.skipIf(process.platform !== "linux");
linux("launchRuntime executes from the real canonical /bin/sh root alias", async () => {
  const f = await shellAliasFixture();
  expect(readFileSync(`/proc/${f.identity.pid}/cmdline`, "utf8").split("\0")[0]).toBe("/bin/sh");
  expect(realpathSync("/bin/sh")).toBe(realpathSync(`/proc/${f.identity.pid}/exe`));
  const lines = createInterface({ input: f.stdout });
  try {
    const started = once(lines, "line");
    await launchRuntime(f.config, f.cli, f.record);
    await started;
    const launched = JSON.parse(readFileSync(f.effect, "utf8")) as { pid: number; argv: string[] };
    expect(processIdentity(launched.pid)).toBeDefined();
    expect(underProcess(launched.pid, f.identity.pid)).toBe(true);
    expect(launched.argv).toContain(`--resume=${f.record.oldRuntime!.sessionFile}`);
    expect(launched.argv).toContain(f.record.toolchain!.nativeConfig);
    expect(sameProcess(f.identity)).toBe(true);
  } finally {
    lines.close();
  }
});

const alternateShell =
  process.platform === "linux"
    ? ["/bin/bash", "/bin/dash"].find((path) => existsSync(path) && realpathSync(path) !== realpathSync("/bin/sh"))
    : undefined;
test.skipIf(!alternateShell)("an sh-named root with /bin/sh argv but a foreign shell image holds", async () => {
  const f = await shellAliasFixture(alternateShell!);
  expect(readFileSync(`/proc/${f.identity.pid}/comm`, "utf8").trim()).toBe("sh");
  expect(readFileSync(`/proc/${f.identity.pid}/cmdline`, "utf8").split("\0")[0]).toBe("/bin/sh");
  expect(realpathSync("/bin/sh")).not.toBe(realpathSync(`/proc/${f.identity.pid}/exe`));
  await expect(launchRuntime(f.config, f.cli, f.record)).rejects.toThrow(DeploymentHeld);
  expect(readFileSync(f.effect, "utf8")).toBe("");
  expect(sameProcess(f.identity)).toBe(true);
  expect(readFileSync(`/proc/${f.identity.pid}/task/${f.identity.pid}/children`, "utf8").trim()).toBe("");
});

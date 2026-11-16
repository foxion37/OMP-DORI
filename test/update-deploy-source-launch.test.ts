import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { DeploymentCli } from "../src/update/deployment-cli.ts";
import { launchedProcess } from "../src/update/deployment-launch.ts";
import { nativeCli } from "../src/update/deployment-native.ts";
import { DeploymentHeld, processIdentity } from "../src/update/deployment-process.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { procCmdline } from "../src/update/proc.ts";
import { digest } from "../src/update/source.ts";
import { deploymentConfig } from "./update-deploy-setup.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test
  .skipIf(process.platform !== "linux" && process.platform !== "darwin")
  .each(["canonical", "launcher", "relative", "other", "missing"])(
  "source-native launch binds only its canonical absolute entry (%s)",
  async (spelling) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-source-launch-")));
    directories.push(root);
    const config = { ...deploymentConfig(root), omp: join(root, "omp"), bun: process.execPath };
    const source = join(root, "source/packages/coding-agent");
    mkdirSync(join(source, "scripts"), { recursive: true });
    mkdirSync(join(source, "src"));
    mkdirSync(join(root, "other"));
    const entry = join(source, "src/cli.ts");
    const other = join(root, "other/cli.ts");
    const body = 'console.log("ready"); await Bun.stdin.text();\n';
    writeFileSync(entry, body);
    writeFileSync(other, body);
    writeFileSync(config.omp, "#!/bin/sh\n");
    const nativeConfig = join(root, "native-config.json");
    writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }));
    const entryArg =
      spelling === "launcher"
        ? `${source}/scripts/../src/cli.ts`
        : spelling === "relative"
          ? relative(root, entry)
          : spelling === "other" || spelling === "missing"
            ? other
            : entry;
    const since = new Date().toISOString();
    const sessionFile = join(root, "session.jsonl");
    const argv = [
      config.bun,
      entryArg,
      `--resume=${sessionFile}`,
      "--dori-role",
      "dori",
      "--model",
      config.model,
      "--config",
      nativeConfig,
      ...(spelling === "missing" ? [join(root, "absent/cli.ts")] : []),
    ];
    if (spelling === "missing") expect(() => realpathSync(argv.at(-1)!)).toThrow();
    const child = Bun.spawn(argv, { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      const identity = processIdentity(child.pid)!;
      expect(identity).toBeDefined();
      expect(procCmdline(child.pid).split("\0")).toContain(entryArg);
      const imageHash = digest(readFileSync(config.bun));
      const record: DeploymentRecord = {
        version: 1,
        id: "source-native-launch",
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
          bunHash: imageHash,
          nativeVersion: "18.20.0",
          nativeConfig,
          nativeConfigHash: digest(readFileSync(nativeConfig)),
          nativeSource: {
            version: 1,
            source: root,
            identity: "d".repeat(64),
            directory: root,
            omp: config.omp,
            ompHash: digest(readFileSync(config.omp)),
            entry,
            bun: config.bun,
            bunHash: imageHash,
            addonLockHash: "e".repeat(64),
            addon: join(root, "addon.node"),
            addonHash: "f".repeat(64),
          },
        },
      };
      record.oldToolchain = record.toolchain!;
      let rootPid = process.pid;
      const cli: DeploymentCli = {
        ...nativeCli(config),
        foreground: async () => ({ shell: false, rootPid, processes: [{ pid: child.pid, name: "bun", argv }] }),
      };
      for (const prior of [false, true]) {
        if (spelling !== "canonical" && spelling !== "launcher") {
          await expect(launchedProcess(config, cli, record, since, prior)).rejects.toThrow(DeploymentHeld);
          continue;
        }
        expect(await launchedProcess(config, cli, record, since, prior)).toEqual(identity);
        await expect(launchedProcess({ ...config, model: "another/model" }, cli, record, since, prior)).rejects.toThrow(
          DeploymentHeld,
        );
        const previous = record.oldRuntime!;
        record.oldRuntime = { ...previous, sessionFile: `${sessionFile}.other` };
        await expect(launchedProcess(config, cli, record, since, prior)).rejects.toThrow(DeploymentHeld);
        record.oldRuntime = previous;
        const toolchain = record.toolchain!;
        const wrongBun = { ...toolchain, bun: "/bin/sh" };
        record.toolchain = wrongBun;
        record.oldToolchain = wrongBun;
        await expect(launchedProcess(config, cli, record, since, prior)).rejects.toThrow(DeploymentHeld);
        record.toolchain = toolchain;
        record.oldToolchain = toolchain;
        rootPid = 0;
        await expect(launchedProcess(config, cli, record, since, prior)).rejects.toThrow(DeploymentHeld);
        rootPid = process.pid;
        record.launchProcess = { ...identity, startTicks: `${BigInt(identity.startTicks) + 1n}` };
        record.rollbackProcess = record.launchProcess;
        await expect(launchedProcess(config, cli, record, since, prior)).rejects.toThrow(
          "startup process differs from its journaled incarnation",
        );
        delete record.launchProcess;
        delete record.rollbackProcess;
      }
    } finally {
      child.stdin.end();
      await child.exited;
    }
  },
);

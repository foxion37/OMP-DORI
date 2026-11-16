import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { hcDeploymentCli } from "../src/update/deployment-cli.ts";
import { ownReleaseRoot } from "../src/update/deployment-files.ts";
import { launchedProcess, launchRuntime, stopLaunchedProcess } from "../src/update/deployment-launch.ts";
import { requireShell } from "../src/update/deployment-native.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import type { DeploymentRecord, RuntimeIdentity } from "../src/update/deployment-types.ts";
import { digest } from "../src/update/source.ts";
import { doriEnv, hc, hcBin, newHome, session, startCore, stopCore, until } from "./e2e-hc-setup.ts";

// Real hc, one isolated core: the foreground group a managed replacement reads is rebuilt from the kernel.
// The native observer's locale, as actorEnv sets it: ps prints its start time in a form Date.parse reads.
const env = { ...doriEnv(newHome("deploy")), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const cli = hcDeploymentCli(async (cmd, argv) => {
  const p = Bun.spawn([cmd, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
});

beforeAll(async () => {
  if (hcBin) await startCore();
});
afterAll(async () => {
  if (hcBin) await stopCore();
});

test.skipIf(!hcBin)(
  "an hc terminal's foreground is its bare shell, then exactly the program started in it",
  async () => {
    // Given an hc terminal running an interactive Bash at its prompt.
    const { address } = (await hc(
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-i",
    )) as {
      address: string;
    };
    const bare = await until("a bare shell", async () => {
      const front = await cli.foreground(address, "held");
      return front.processes?.length === 1 ? front : undefined;
    });
    // Then the foreground is that shell alone, leading its own group.
    expect(bare.shell).toBe(true);
    expect(bare.processes![0]).toMatchObject({ pid: bare.rootPid, name: "bash" });
    expect(bare.pgid).toBe(bare.rootPid);
    // When a program is started in it.
    await cli.start(address, "exec 3>&-; sleep 300");
    const running = await until("the started program in front", async () => {
      const front = await cli.foreground(address, "held");
      return front.processes?.some((p) => p.name === "sleep") ? front : undefined;
    });
    // Then that program is the whole foreground group, the shell stays its root, and no shell is in front.
    expect(running.shell).toBe(false);
    expect(running.rootPid).toBe(bare.rootPid);
    expect(running.processes).toEqual([{ pid: running.pgid!, name: "sleep", argv: ["sleep", "300"] }]);
    // And the probe reports the same kernel foreground.
    const probe = await cli.probe(address, "held", newHome("deploy-state"));
    expect(probe).toMatchObject({ shellInFront: false, rootPid: bare.rootPid, pgid: running.pgid });
    await hc("kill", address);
  },
);

test.skipIf(!hcBin)(
  "a managed launch on hc starts once in the bare shell, is identified by the kernel, and stops back to it",
  async () => {
    // Given an hc terminal at an interactive Bash prompt and a deployment of that terminal with a private native stand-in.
    const root = realpathSync(newHome("deploy-launch"));
    const { address } = (await hc(
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--cwd",
      root,
      "--",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-i",
    )) as {
      address: string;
    };
    const config = parseDeploymentConfig(
      {
        releaseRoot: "managed",
        liveSource: "home/.dori/src",
        home: "home",
        doriHome: "home/.dori",
        doriConfig: "home/.dori/config.json",
        stateDir: "home/.dori/state",
        bun: process.execPath,
        omp: "native-omp",
        runtime: "hc",
        hc: hcBin!,
        hcSession: session,
        pane: address,
        sessionId: "preserved-session",
        model: "openai-codex/gpt-6.1-sol",
        restartLock: "home/.dori/restart.lock",
        launcherPath: "home/.dori/bin/restart",
        healthTimeoutMs: 100,
        stopTimeoutMs: 5_000,
      },
      root,
    );
    writeFileSync(config.omp, `#!${process.execPath}\nawait Bun.stdin.text();\n`, { mode: 0o700 });
    ownReleaseRoot(config);
    const nativeConfig = join(config.releaseRoot, "native-config.json");
    writeFileSync(nativeConfig, JSON.stringify({ update: { auto: false } }), { mode: 0o600 });
    const toolchain = {
      omp: config.omp,
      ompEntry: realpathSync(config.omp),
      ompEntryHash: digest(readFileSync(config.omp)),
      bun: process.execPath,
      bunHash: digest(readFileSync(process.execPath)),
      nativeVersion: "18.18.8",
      nativeConfig,
      nativeConfigHash: digest(readFileSync(nativeConfig)),
    };
    const record = {
      oldRuntime: { cwd: root, sessionFile: join(root, "session.jsonl") } as RuntimeIdentity,
      toolchain,
    } as DeploymentRecord;
    await until("a bare shell", async () => ((await requireShell(config, cli)) === undefined ? true : undefined));
    // When the managed launch types the native command into it.
    const since = new Date().toISOString();
    await launchRuntime(config, cli, record);
    const launched = await until("the launched native process", () => launchedProcess(config, cli, record, since));
    // Then the kernel identifies exactly that process under the terminal's shell, running the private native entry.
    expect(launched.executable).toBe(realpathSync(process.execPath));
    expect(sameProcess(launched)).toBe(true);
    // When it is stopped as an owned startup, then it is gone and the terminal is a bare shell again.
    await stopLaunchedProcess(config, cli, record, since, launched);
    expect(sameProcess(launched)).toBe(false);
    await requireShell(config, cli);
    await hc("kill", address);
  },
  60_000,
);

test.skipIf(!hcBin)("a terminal hc does not know is doubt", async () => {
  expect(await cli.foreground("t999", "held")).toEqual({ shell: true });
});

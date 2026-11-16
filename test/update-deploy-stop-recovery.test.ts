import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import { stopLaunchedProcess } from "../src/update/deployment-launch.ts";
import { DeploymentHeld, processIdentity, sameProcess, underProcess } from "../src/update/deployment-process.ts";
import { rollbackDeployment } from "../src/update/deployment-rollback.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix.each([2, 3])("startup stop recaptures after a real foreground child exits during probe %s", async (cut) => {
  const f = await managedBashFixture({ transient: true });
  const expected = processIdentity(f.runtime.pid)!;
  expect(processIdentity(f.previousRuntime!.pid)).toBeUndefined();
  const pulse = processIdentity(f.front.foreground_processes.at(-1)!.pid!)!;
  expect(underProcess(pulse.pid, expected.pid)).toBe(true);
  f.record.launchProcess = expected;
  f.writeHealth({ ...f.health, presetLoaded: false });
  let observations = 0;
  let expired = false;
  const cli = herdrDeploymentCli(async (cmd, args) => {
    const snapshot = await f.cli.exec(cmd, args);
    if (cmd === "herdr" && args[3] === "process-info") {
      observations++;
      if (sameProcess(expected)) expect(existsSync(f.signalPath)).toBe(false);
      if (observations === cut) {
        expect(sameProcess(pulse)).toBe(true);
        process.kill(pulse.pid, "SIGTERM");
        // Real kernel reaping cannot be advanced with a fake JS clock.
        const until = Date.now() + 1_000;
        while (processIdentity(pulse.pid) && Date.now() < until)
          await f.cli.exec("ps", ["-o", "stat=", "-p", String(pulse.pid)]);
        expect(processIdentity(pulse.pid)).toBeUndefined();
        f.front.foreground_processes = f.front.foreground_processes.filter(({ pid }) => pid !== pulse.pid);
        expired = true;
      }
    }
    return snapshot;
  }, f.config.herdrSession!);
  await stopLaunchedProcess(f.config, cli, f.record, f.launchRequestedAt, expected);
  expect(expired).toBe(true);
  expect(observations).toBeGreaterThan(cut + 1);
  expect(sameProcess(expected)).toBe(false);
  for (const monitor of f.bootstrap.running!) expect(sameProcess(monitor.identity!)).toBe(false);
  expect(readFileSync(f.signalPath, "utf8")).toBe("SIGTERM");
});

posix("an interrupted pre-signal capture never signals the owned startup", async () => {
  const f = await managedBashFixture();
  const expected = processIdentity(f.runtime.pid)!;
  const controller = new AbortController();
  let observations = 0;
  const cli = herdrDeploymentCli(async (cmd, args) => {
    const snapshot = await f.cli.exec(cmd, args);
    if (cmd === "herdr" && args[3] === "process-info" && ++observations === 3) controller.abort();
    return snapshot;
  }, f.config.herdrSession!);
  await expect(
    stopLaunchedProcess(f.config, cli, f.record, f.launchRequestedAt, expected, controller.signal),
  ).rejects.toThrow(DeploymentHeld);
  expect(observations).toBe(3);
  expect(sameProcess(expected)).toBe(true);
  expect(existsSync(f.signalPath)).toBe(false);
});

posix("rollback journals an unrecorded live startup after a real stale-child snapshot, before any signal", async () => {
  const f = await managedBashFixture({ transient: true });
  expect(processIdentity(f.previousRuntime!.pid)).toBeUndefined();
  const expected = processIdentity(f.runtime.pid)!;
  const pulse = processIdentity(f.front.foreground_processes.at(-1)!.pid!)!;
  const observation = join(f.root, "foreground.json");
  const counts = join(f.root, "process-info-count");
  const expired = join(f.root, "child-exit-proof");
  writeFileSync(
    f.config.herdr,
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { processIdentity, sameProcess, underProcess } from ${JSON.stringify(new URL("../src/update/deployment-process.ts", import.meta.url).href)};
const operation = process.argv[process.argv.indexOf("pane") + 1];
if (operation !== "get" && operation !== "process-info") throw new Error("unexpected pane mutation");
const snapshot = JSON.parse(readFileSync(${JSON.stringify(observation)}, "utf8"));
if (operation === "process-info") {
  const count = (existsSync(${JSON.stringify(counts)}) ? Number(readFileSync(${JSON.stringify(counts)}, "utf8")) : 0) + 1;
  writeFileSync(${JSON.stringify(counts)}, String(count));
  if (count === 2) {
    const owner = ${JSON.stringify(expected)};
    const pulse = ${JSON.stringify(pulse)};
    if (!sameProcess(owner) || !sameProcess(pulse) || !underProcess(pulse.pid, owner.pid)) throw new Error("fixture owner changed");
    process.kill(pulse.pid, "SIGTERM");
    const until = Date.now() + 1_000;
    while (processIdentity(pulse.pid) && Date.now() < until) {
      const ps = Bun.spawn(["ps", "-o", "stat=", "-p", String(pulse.pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await ps.exited;
    }
    if (processIdentity(pulse.pid)) throw new Error("owned child did not exit");
    const next = structuredClone(snapshot);
    next.front.foreground_processes = next.front.foreground_processes.filter(entry => entry.pid !== pulse.pid);
    writeFileSync(${JSON.stringify(observation)}, JSON.stringify(next));
    writeFileSync(${JSON.stringify(expired)}, JSON.stringify({ pulse, current: processIdentity(pulse.pid) ?? null }));
  }
}
const result = operation === "get" ? { pane: { agent: "omp", agent_status: "idle" } } : { process_info: snapshot.front };
console.log(JSON.stringify({ result }));
`,
    { mode: 0o700 },
  );
  const interrupted = new Error("owned rollback journal persisted before startup stop");
  await expect(
    rollbackDeployment(f.config, f.record, (record) => {
      f.persist(record);
      if (record.launchProcess) throw interrupted;
    }),
  ).rejects.toBe(interrupted);
  expect(Number(readFileSync(counts, "utf8"))).toBeGreaterThan(2);
  expect(JSON.parse(readFileSync(expired, "utf8"))).toMatchObject({ pulse, current: null });
  expect(JSON.parse(readFileSync(f.journal, "utf8"))).toMatchObject({ launchProcess: expected, step: "rollback" });
  expect(processIdentity(pulse.pid)).toBeUndefined();
  expect(sameProcess(expected)).toBe(true);
  expect(existsSync(f.signalPath)).toBe(false);
  expect(existsSync(f.effect)).toBe(false);
});

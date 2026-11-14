import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateInterrupted } from "../src/update/config.ts";
import { runCommand } from "../src/update/process.ts";
import { reportCandidate } from "../src/update/report.ts";
import { sourceManifest } from "../src/update/source.ts";
import type { UpdateJob } from "../src/update/types.ts";
import { fixture } from "./update-setup.ts";

// These subprocess/pipe integrations use real handshakes and deadlines; fake time cannot drive child processes.
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("execution fixture did not reach its handshake");
    await Bun.sleep(20);
  }
}

function executionFixture() {
  const f = fixture();
  const directory = join(f.directory, "execution");
  mkdirSync(directory);
  const at = new Date().toISOString();
  const job: UpdateJob = {
    version: 1,
    id: "a".repeat(64),
    upstream: f.config.baseUpstream,
    baseUpstream: f.config.baseUpstream,
    configHash: f.updater.context.configHash,
    createdAt: at,
    updatedAt: at,
    phase: "verifying",
    candidate: f.localSource,
    directory,
    sourceHash: sourceManifest(f.localSource).hash,
    commands: [],
    history: [{ phase: "verifying", at }],
  };
  return { ...f, job };
}

function inheritedPipes(mode: "exit" | "wait", timeoutMs = 10_000) {
  const f = executionFixture();
  const child = join(f.directory, "pipe-child.ts");
  const parent = join(f.directory, "pipe-parent.ts");
  const identity = join(f.directory, "child.json");
  const stop = join(f.directory, "stop-child");
  const stopped = join(f.directory, "child-stopped.json");
  const ready = join(f.directory, "parent-ready");
  const token = randomUUID();
  f.write(
    f.directory,
    "pipe-child.ts",
    `
import { existsSync, writeFileSync, writeSync } from "node:fs";
const [identity, stop, stopped, token] = process.argv.slice(2);
const evidence = JSON.stringify({ pid: process.pid, token });
writeSync(1, "retained stdout before inherited-pipe hold\\n");
writeSync(2, "retained stderr before inherited-pipe hold\\n");
writeFileSync(identity, evidence);
const finish = () => { writeFileSync(stopped, evidence); process.exit(0); };
setTimeout(finish, 15_000);
while (!existsSync(stop)) await Bun.sleep(20);
finish();
`,
  );
  f.write(
    f.directory,
    "pipe-parent.ts",
    `
import { existsSync, writeFileSync } from "node:fs";
const [child, identity, stop, stopped, ready, token, mode] = process.argv.slice(2);
const descendant = Bun.spawn([process.execPath, child, identity, stop, stopped, token], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
descendant.unref();
while (!existsSync(identity)) await Bun.sleep(20);
writeFileSync(ready, "ready");
if (mode === "exit") process.exit(0);
await Bun.sleep(20_000);
`,
  );
  const command = {
    name: "inherited-pipes",
    timeoutMs,
    argv: [process.execPath, parent, child, identity, stop, stopped, ready, token, mode],
  };
  return {
    ...f,
    command,
    ready,
    stopped,
    cleanup: async () => {
      writeFileSync(stop, "stop only this fixture's descendant");
      await waitFor(() => existsSync(stopped));
      const started = JSON.parse(readFileSync(identity, "utf8")) as { pid: number; token: string };
      expect(started.token).toBe(token);
      expect(started.pid).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(stopped, "utf8"))).toEqual(started);
    },
  };
}

function retainedInterruption(job: UpdateJob, error: unknown) {
  expect(error).toBeInstanceOf(UpdateInterrupted);
  const receipt = job.commands.at(-1)!;
  expect(receipt.pid).toBeGreaterThan(0);
  expect(receipt.finishedAt).toBeDefined();
  expect(receipt.sourceHash).toBe(job.sourceHash);
  expect(receipt.error).toContain("descendants may still be running");
  const persisted = JSON.parse(readFileSync(join(job.directory, "job.json"), "utf8")) as UpdateJob;
  expect(persisted.commands.at(-1)).toEqual(receipt);
  expect(readFileSync(receipt.stdout, "utf8")).toContain("retained stdout");
  expect(readFileSync(receipt.stderr, "utf8")).toContain("retained stderr");
  return receipt;
}

describe("bounded candidate command output", () => {
  test("exit zero with inherited pipes is interrupted and closes both logs", async () => {
    const f = inheritedPipes("exit");
    let paths: string[] = [];
    let before: string[] = [];
    try {
      const started = Date.now();
      const error = await runCommand(f.updater.context, f.job, f.command).catch((error: unknown) => error);
      const receipt = retainedInterruption(f.job, error);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(receipt.exitCode).toBe(0);
      expect(receipt.error).toContain("output is incomplete");
      expect(existsSync(f.stopped)).toBe(false);
      paths = [receipt.stdout, receipt.stderr];
      before = paths.map((path) => readFileSync(path, "utf8"));
    } finally {
      await f.cleanup();
    }
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  }, 30_000);

  test.each(["deadline", "abort"] as const)(
    "%s interrupts inherited pipes with a durable receipt",
    async (mode) => {
      const f = inheritedPipes("wait", mode === "deadline" ? 3_000 : 10_000);
      const controller = new AbortController();
      const ctx = { ...f.updater.context, signal: controller.signal };
      const pending = runCommand(ctx, f.job, f.command).catch((error: unknown) => error);
      let started = Date.now();
      try {
        if (mode === "abort") {
          await waitFor(() => existsSync(f.ready));
          started = Date.now();
          controller.abort();
        }
        const receipt = retainedInterruption(f.job, await pending);
        expect(Date.now() - started).toBeLessThan(mode === "deadline" ? 10_000 : 8_000);
        expect(receipt.signal).toBe("SIGKILL");
        expect(receipt.error).toContain(mode === "deadline" ? "command deadline expired" : "updater aborted command");
        expect(receipt.error).toContain("output is incomplete");
        expect(existsSync(f.stopped)).toBe(false);
      } finally {
        controller.abort();
        await f.cleanup();
        await pending;
      }
    },
    30_000,
  );

  test("incomplete reporter output stays ambiguous and is never resent", async () => {
    const f = inheritedPipes("exit");
    const ctx = { ...f.updater.context, config: { ...f.config, reporter: f.command } };
    f.job.phase = "failed";
    try {
      await reportCandidate(ctx, f.job);
      expect(f.job.notification?.state).toBe("ambiguous");
      expect(f.job.phase).toBe("failed");
      expect(f.job.commands.at(-1)?.exitCode).toBe(0);
      expect(f.job.commands.at(-1)?.error).toContain("output is incomplete");
      const restarted = JSON.parse(readFileSync(join(f.job.directory, "job.json"), "utf8")) as UpdateJob;
      await reportCandidate(ctx, restarted);
      expect(restarted.notification?.state).toBe("ambiguous");
      expect(restarted.commands.filter((receipt) => receipt.name === f.command.name)).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  test("redacts longer prefix-overlapping secrets across both pipes and error receipts", async () => {
    const f = executionFixture();
    const short = "SECRET_alpha";
    const secret = "SECRET_alpha_unique_omega_VALUE";
    const names = ["DORI_EXECUTION_SHORT_SECRET", "DORI_EXECUTION_LONG_SECRET"] as const;
    const release = join(f.directory, "release-writer");
    writeFileSync(
      join(f.directory, "split-output.ts"),
      `
import { existsSync, writeSync } from "node:fs";
import { runCommand } from ${JSON.stringify(new URL("../src/update/process.ts", import.meta.url).href)};
const release = ${JSON.stringify(release)};
const secret = process.env["DORI_EXECUTION_LONG_SECRET"];
if (process.argv[2] === "emit") {
  setTimeout(() => process.exit(2), 15_000);
  writeSync(1, "stdout-prefix:" + "a".repeat(256) + secret.slice(0, 14));
  writeSync(2, "stderr-prefix:" + "b".repeat(256) + secret.slice(0, 14));
  while (!existsSync(release)) await Bun.sleep(20);
  writeSync(1, secret.slice(14) + "\\nstdout-end\\n");
  writeSync(2, secret.slice(14) + "\\nstderr-end\\n");
  process.exit(0);
}
const job = ${JSON.stringify(f.job)};
const ctx = { config: ${JSON.stringify({ ...f.config, reporterEnv: names })}, configHash: ${JSON.stringify(f.job.configHash)}, emit: () => {} };
await runCommand(ctx, job, { name: "split-output", argv: [process.execPath, import.meta.path, "emit"], timeoutMs: 10_000 }, {}, "reporter");
await runCommand(ctx, job, { name: "secret-error", argv: [${JSON.stringify(join(f.directory, secret))}], timeoutMs: 10_000 }, {}, "reporter").catch(() => {});
`,
    );
    const proc = Bun.spawn([process.execPath, join(f.directory, "split-output.ts")], {
      env: { PATH: process.env["PATH"], [names[0]]: short, [names[1]]: secret },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 20_000,
    });
    const stderr = new Response(proc.stderr).text();
    try {
      const jobPath = join(f.job.directory, "job.json");
      await waitFor(() => existsSync(jobPath));
      const receipt = (JSON.parse(readFileSync(jobPath, "utf8")) as UpdateJob).commands[0]!;
      await waitFor(() =>
        [receipt.stdout, receipt.stderr].every(
          (path) => existsSync(path) && readFileSync(path, "utf8").includes("-prefix:"),
        ),
      );
      writeFileSync(release, "both first chunks were recorded");
      expect([await proc.exited, await stderr]).toEqual([0, ""]);
      const persisted = JSON.parse(readFileSync(jobPath, "utf8")) as UpdateJob;
      expect(persisted.commands[0]?.exitCode).toBe(0);
      const output = [receipt.stdout, receipt.stderr].map((path) => readFileSync(path, "utf8"));
      expect(output.every((text) => text.includes("-end"))).toBe(true);
      for (const text of [...output, persisted.commands[1]?.error ?? ""]) {
        expect(text).toContain("[redacted]");
        expect(text).not.toContain(short);
        expect(text).not.toContain(secret.slice(short.length));
      }
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release only this fixture's writer");
      await Promise.all([proc.exited, stderr]);
    }
  }, 30_000);
});

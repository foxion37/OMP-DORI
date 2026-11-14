import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { join } from "node:path";
import type { UpdateState } from "../src/update/types.ts";
import { type DetectionReceipt, detectionReceipt, waitFor } from "./update-detection-setup.ts";
import { fixture } from "./update-setup.ts";

// Real TLS sockets, OS process groups and pipe EOF require the platform clock rather than fake timers.
test("real Git HTTPS blackhole stops its owned group before a retry and leaves unrelated work live", async () => {
  const f = fixture();
  const git = Bun.which("git");
  if (!git) throw new Error("fixture requires Git");
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const bin = join(f.directory, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const next = join(f.directory, "next-success");
  const resultPath = join(f.directory, "result.json");
  const config = join(f.directory, "config.json");
  writeFileSync(config, JSON.stringify(f.config));
  // exec preserves the detector PID/group while real Git and git-remote-https stall on local TLS input.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ -f '${next}' ]; then exec '${git}' "$@"; fi
exec '${git}' -c 'url.https://127.0.0.1:${address.port}/blackhole.git.insteadOf=${f.remote}' "$@"
`,
    { mode: 0o700 },
  );
  const heartbeat = join(f.directory, "unrelated-heartbeat");
  const unrelated = spawn(
    process.execPath,
    [
      "-e",
      `
import { appendFileSync } from "node:fs";
setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "alive\\n"), 20);
`,
    ],
    { detached: true, stdio: "ignore" },
  );
  const unrelatedExit = Promise.withResolvers<void>();
  unrelated.once("exit", () => unrelatedExit.resolve());
  const runnerPath = join(f.directory, "detect.ts");
  writeFileSync(
    runnerPath,
    `
import { mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
const prepareURL = ${JSON.stringify(new URL("../src/update/prepare.ts", import.meta.url).href)};
const original = await import(prepareURL);
const detect = original.detectHead;
const prepareCandidate = original.prepareCandidate;
// Only the internal deadline changes; the CLI, recorder and actual Git child execute normally.
// CLI imports must follow the deadline-only module seam so its detector binding sees the injected bound.
mock.module(prepareURL, () => ({ detectHead: (ctx) => detect(ctx, 1_500), prepareCandidate }));
const { runUpdate } = await import(${JSON.stringify(new URL("../src/update/cli.ts", import.meta.url).href)});
const { DoriUpdater } = await import(${JSON.stringify(new URL("../src/update/controller.ts", import.meta.url).href)});
const { loadUpdateConfig } = await import(${JSON.stringify(new URL("../src/update/load.ts", import.meta.url).href)});
const updater = new DoriUpdater(loadUpdateConfig(${JSON.stringify(config)}), () => {});
const firstCode = await runUpdate(["check", "--config", ${JSON.stringify(config)}]);
const receipt = JSON.parse(readFileSync(${JSON.stringify(join(f.config.root, "detector", "last-detection.json"))}, "utf8"));
const before = updater.status().state;
writeFileSync(${JSON.stringify(next)}, "restore the actual configured local remote for the next check");
const nextCode = await runUpdate(["check", "--config", ${JSON.stringify(config)}]);
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
  firstCode, receipt, before, nextCode, state: updater.status().state,
}));
`,
  );
  const runner = Bun.spawn([process.execPath, runnerPath], {
    cwd: f.directory,
    env: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: 15_000,
  });
  const stderr = new Response(runner.stderr).text();
  try {
    const startedPath = join(f.config.root, "detector", "detection-started.json");
    // Git may connect while the controller is still reading its initial process table, before saving its receipt.
    await waitFor(() => sockets.size > 0 && existsSync(heartbeat) && existsSync(startedPath));
    const started = JSON.parse(readFileSync(startedPath, "utf8")) as { pid: number };
    const active = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat=,comm="], { encoding: "utf8", timeout: 1_000 });
    expect(active.status).toBe(0);
    const members = active.stdout.split("\n").flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      return row && Number(row[2]) === started.pid && !row[3]?.startsWith("Z") ? [row] : [];
    });
    expect(members.some((row) => Number(row[1]) === started.pid && /git$/.test(row[4] ?? ""))).toBe(true);
    expect(members.some((row) => Number(row[1]) !== started.pid && /git-remote-http/.test(row[4] ?? ""))).toBe(true);
    expect(await runner.exited).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      firstCode: number;
      receipt: DetectionReceipt;
      before: UpdateState;
      nextCode: number;
      state: UpdateState;
    };
    expect(result.firstCode).toBe(4);
    expect(result.before.jobs).toEqual({});
    expect(result.before.active).toBeUndefined();
    expect(result.before.observed).toBeUndefined();
    expect(result.receipt.pid).toBe(started.pid);
    expect(result.receipt.signal).toBe("SIGKILL");
    expect(result.receipt.detector).toEqual({
      group: started.pid,
      groupVerified: true,
      reason: "deadline",
      outputComplete: true,
      stopped: true,
      escaped: [],
    });
    const stopped = spawnSync("/bin/ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", timeout: 1_000 });
    expect(stopped.status).toBe(0);
    expect(
      stopped.stdout.split("\n").filter((line) => {
        const row = /^\s*(\d+)\s+(\S+)/.exec(line);
        return Number(row?.[1]) === started.pid && !row?.[2]?.startsWith("Z");
      }),
    ).toEqual([]);
    await waitFor(() => sockets.size === 0);
    const accepted = connections;
    const beforeHeartbeat = statSync(heartbeat).size;
    await waitFor(() => statSync(heartbeat).size > beforeHeartbeat);
    expect(connections).toBe(accepted);
    expect(statSync(heartbeat).size).toBeGreaterThan(beforeHeartbeat);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    expect(result.nextCode).toBe(0);
    expect(result.state.jobs).toEqual({});
    expect(result.state.observed).toBe(f.config.baseUpstream);
    const after = detectionReceipt(f.config.root);
    expect(after.receiptPath).not.toBe(result.receipt.receiptPath);
    expect(after.exitCode).toBe(0);
    for (const invocation of [result.receipt, after]) {
      const { receiptPath, ...receipt } = invocation;
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt);
      for (const path of [receiptPath, receipt.stdout, receipt.stderr]) expect(statSync(path).mode & 0o077).toBe(0);
    }
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    await runner.exited;
    await stderr;
    unrelated.kill("SIGKILL");
    await unrelatedExit.promise;
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}, 25_000);

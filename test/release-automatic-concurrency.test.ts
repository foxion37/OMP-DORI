import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { automaticLaunch, automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState, saveAutomaticState, setAutomaticEnabled } from "../src/release/automatic-state.ts";
import { acquireConsumerLock } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { acquireLaunchGate, assertNoConsumerLaunches, registerConsumerLaunch } from "../src/release/launch-leases.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { fixture } from "./release-consumer-setup.ts";
import { blockStatePublication, boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix.each(["due", "disabled", "ttl", "managed", "-h", "-v", "--help", "--version"])(
  "a %s launch verifies and runs without waiting for another consumer updater",
  async (mode) => {
    const f = fixture();
    const installed = await installBundle(f.paths, f.release("one").bundle, undefined);
    const source = releasePath(f.paths, installed.current);
    if (mode === "disabled") setAutomaticEnabled(f.paths, false);
    if (mode === "ttl") saveAutomaticState(f.paths, { version: 1, enabled: true, nextCheck: Date.now() + 86_400_000 });
    const before = readAutomaticState(f.paths);
    const unlock = acquireConsumerLock(f.paths);
    try {
      const argv = mode === "managed" ? ["--no-extensions"] : mode.startsWith("-") ? [mode] : [];
      const started = performance.now();
      expect(await automaticLaunch(source, f.paths.home, argv)).toBe(source);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(readAutomaticState(f.paths)).toEqual(before);
    } finally {
      unlock();
    }
  },
);

posix("a concurrently registered launch holds the updater at activation, not the new launch", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const next = boundRelease(f, "two").bundle;
  const candidate = { ...next, manifest: { ...next.manifest, prerelease: false } };
  const source = releasePath(f.paths, one.current);
  const selected = await automaticUpdate(f.paths, {
    now: 40,
    checkTools: () => {},
    acquire: async () => {
      const gate = acquireLaunchGate(f.paths);
      try {
        registerConsumerLaunch(f.paths, process.pid);
      } finally {
        gate();
      }
      expect(await automaticLaunch(source, f.paths.home, ["--no-extensions"])).toBe(source);
      return candidate;
    },
  });
  expect(selected).toBe(source);
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  expect(readAutomaticState(f.paths).outcome).toBe("held");
});

posix("a launch lease remains live across shell exec and is reclaimed only after that process exits", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const child = Bun.spawn(["/bin/sh", "-c", "read token; exec sleep 60"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const before = processIdentity(child.pid);
    expect(before).toBeDefined();
    const gate = acquireLaunchGate(f.paths);
    try {
      registerConsumerLaunch(f.paths, child.pid);
    } finally {
      gate();
    }
    child.stdin.write("continue\n");
    child.stdin.end();
    for (let at = 0; at < 100 && processIdentity(child.pid)?.executable === before?.executable; at++)
      await Bun.sleep(10);
    const after = processIdentity(child.pid);
    expect(after?.executable).not.toBe(before?.executable);
    expect(after?.startTicks).toBe(before?.startTicks);
    expect(after?.bootId).toBe(before?.bootId);
    await expect(installBundle(f.paths, f.release("two").bundle, one)).rejects.toThrow("Live consumer launch PID");
    expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const gate = acquireLaunchGate(f.paths);
  try {
    assertNoConsumerLaunches(f.paths);
  } finally {
    gate();
  }
  expect(readdirSync(join(f.paths.root, "consumer-launches"))).toEqual([]);
});

posix("the owner of an automatic startup may activate while other live launch owners still veto it", async () => {
  const f = fixture();
  await installBundle(f.paths, f.release("one").bundle, undefined);
  const next = boundRelease(f, "two").bundle;
  const gate = acquireLaunchGate(f.paths);
  try {
    registerConsumerLaunch(f.paths, process.pid);
  } finally {
    gate();
  }
  const candidate = { ...next, manifest: { ...next.manifest, prerelease: false } };
  expect(
    await automaticUpdate(f.paths, {
      now: 40,
      launchOwner: process.pid,
      checkTools: () => {},
      acquire: async () => candidate,
    }),
  ).toBe(releasePath(f.paths, candidate.manifest));
  expect(readAutomaticState(f.paths).outcome).toBe("installed");
});

posix("a registered launcher recovers a failed state publication and still runs the old verified release", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const next = boundRelease(f, "two").bundle;
  const candidate = { ...next, manifest: { ...next.manifest, prerelease: false } };
  const fault = blockStatePublication(f.paths, f.root, releasePath(f.paths, candidate.manifest));
  const gate = acquireLaunchGate(f.paths);
  try {
    registerConsumerLaunch(f.paths, process.pid);
  } finally {
    gate();
  }
  expect(
    await automaticUpdate(fault.paths, {
      now: 40,
      launchOwner: process.pid,
      checkTools: () => {},
      acquire: async () => candidate,
    }),
  ).toBe(releasePath(f.paths, one.current));
  expect(fault.observed).toHaveLength(1);
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  expect(readAutomaticState(f.paths).outcome).toBe("failed");
});

posix("a real contender waits across the launch-lock mkdir/owner gap without stealing it", async () => {
  const f = fixture();
  const lock = join(f.paths.root, "consumer-launch.lock");
  mkdirSync(lock, { mode: 0o700 });
  const module = new URL("../src/release/launch-leases.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {waitLaunchGate} from ${JSON.stringify(module)}; const unlock = await waitLaunchGate(JSON.parse(process.argv[1])); unlock(); console.log("ADMITTED");`,
      JSON.stringify(f.paths),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await Bun.sleep(100);
    expect(child.exitCode).toBeNull();
    writeFileSync(join(lock, "owner.json"), JSON.stringify(processIdentity(process.pid)), { mode: 0o600 });
    await Bun.sleep(50);
    expect(child.exitCode).toBeNull();
    unlinkSync(join(lock, "owner.json"));
    rmdirSync(lock);
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, error).toBe(0);
    expect(out.trim()).toBe("ADMITTED");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

posix("simultaneous real shell launches all pass while the long update lock is occupied", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const source = releasePath(f.paths, one.current);
  const script = new URL("../src/release/automatic.ts", import.meta.url).pathname;
  const unlock = acquireConsumerLock(f.paths);
  try {
    const runs = Array.from({ length: 8 }, () =>
      Bun.spawn(
        [
          "/bin/sh",
          "-c",
          '"$1" "$2" "$3" "$4" "$$"; result=$?; exit "$result"',
          "launch-test",
          process.execPath,
          script,
          source,
          f.paths.home,
        ],
        { stdout: "pipe", stderr: "pipe", env: { HOME: f.paths.home, PATH: process.env["PATH"] } },
      ),
    );
    const results = await Promise.all(
      runs.map(async (run) => ({
        code: await run.exited,
        stdout: await new Response(run.stdout).text(),
        stderr: await new Response(run.stderr).text(),
      })),
    );
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(source);
    }
    expect(readAutomaticState(f.paths).lastAttempt).toBeUndefined();
  } finally {
    unlock();
  }
});

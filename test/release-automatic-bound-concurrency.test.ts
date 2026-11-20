import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBundle } from "../src/release/install.ts";
import { acquireLaunchGate, assertNoConsumerLaunches } from "../src/release/launch-leases.ts";
import { releasePath } from "../src/release/state.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { fixture } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix.each([false, true])(
  "simultaneous bound-native admission shares only verified immutable caches (side=%s)",
  async (side) => {
    const f = fixture(side);
    const bound = boundRelease(f, "shared-native");
    const one = await installBundle(f.paths, bound.bundle, undefined);
    const source = releasePath(f.paths, one.current);
    const script = new URL("../src/release/automatic.ts", import.meta.url).pathname;
    for (let round = 0; round < 3; round++) {
      const runs = Array.from({ length: 8 }, () =>
        Bun.spawn(
          [
            "/bin/sh",
            "-c",
            '"$1" "$2" "$3" "$4" "$$"; result=$?; exit "$result"',
            "bound-launch-test",
            process.execPath,
            script,
            source,
            f.paths.home,
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: { HOME: f.paths.home, PATH: process.env["PATH"], DORI_AUTO_UPDATE: "0" },
          },
        ),
      );
      const results = await Promise.all(
        runs.map(async (run) => ({
          code: await run.exited,
          out: await new Response(run.stdout).text(),
          err: await new Response(run.stderr).text(),
        })),
      );
      for (const result of results) {
        expect(result.code, result.err).toBe(0);
        expect(result.out.trim()).toBe(source);
      }
    }
  },
  30_000,
);

posix.each(["", "not-a-kernel-start"])(
  "a malformed live launch start identity is held, never pruned (%s)",
  async (startTicks) => {
    const f = fixture();
    const identity = processIdentity(process.pid)!;
    const lease = { version: 1, pid: process.pid, startTicks, bootId: identity.bootId };
    const directory = join(f.paths.root, "consumer-launches");
    mkdirSync(directory, { mode: 0o700 });
    const hash = createHash("sha256").update(JSON.stringify(lease)).digest("hex");
    const path = join(directory, `${process.pid}-${hash}.json`);
    writeFileSync(path, JSON.stringify(lease), { mode: 0o600 });
    const gate = acquireLaunchGate(f.paths);
    try {
      expect(() => assertNoConsumerLaunches(f.paths)).toThrow("Invalid consumer launch receipt");
    } finally {
      gate();
    }
    expect(existsSync(path)).toBe(true);
  },
);

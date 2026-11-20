import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireConsumerLock } from "../src/release/files.ts";
import { assertNoLiveDori } from "../src/release/live.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { processExists } from "../src/update/proc.ts";
import { fixture } from "./release-consumer-setup.ts";

test("process existence query distinguishes the current process from an exited child", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("Could not start the disposable child");
  await once(child, "exit");

  expect(processExists(process.pid)).toBe(true);
  expect(processExists(pid)).toBe(false);
});

const darwin = test.skipIf(process.platform !== "darwin");

darwin.each(["runtime", "lock"] as const)(
  "%s remains held when a live process executable is unavailable",
  async (kind) => {
    const { paths } = fixture();
    const executable = join(paths.home, "sleep-witness");
    copyFileSync("/bin/sleep", executable);
    const child = spawn(executable, ["60"]);
    await once(child, "spawn");
    const exited = once(child, "exit");
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("Could not start the disposable child");
      const identity = processIdentity(pid);
      if (!identity) throw new Error("Disposable child identity was unavailable before unlink");
      unlinkSync(executable);
      expect(processIdentity(pid)).toBeUndefined();
      expect(processExists(pid)).toBe(true);

      if (kind === "runtime") {
        const runtime = join(paths.dori, "state", "runtime");
        mkdirSync(runtime, { recursive: true, mode: 0o700 });
        writeFileSync(join(runtime, "witness.json"), JSON.stringify({ ...identity, role: "dori" }));
        expect(() => assertNoLiveDori(paths)).toThrow("identity is unavailable");
      } else {
        const lock = join(paths.root, "consumer.lock");
        const owner = join(lock, "owner.json");
        const receipt = JSON.stringify(identity);
        mkdirSync(lock, { mode: 0o700 });
        writeFileSync(owner, receipt, { mode: 0o600 });
        expect(() => acquireConsumerLock(paths)).toThrow("lock is held");
        expect(readFileSync(owner, "utf8")).toBe(receipt);
      }
    } finally {
      child.kill();
      await exited;
    }
  },
);

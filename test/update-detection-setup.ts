import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DetectionReceipt as DetectorCommandReceipt } from "../src/update/detection-process.ts";
import { fixture } from "./update-setup.ts";

export type DetectionReceipt = DetectorCommandReceipt & { readonly receiptPath: string };
export const detectionReceipt = (root: string): DetectionReceipt =>
  JSON.parse(readFileSync(join(root, "detector", "last-detection.json"), "utf8")) as DetectionReceipt;

// Real inherited descriptors require subprocess handshakes; fake time cannot drive pipe EOF or child exit.
export async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("detector fixture did not reach its handshake");
    await Bun.sleep(20);
  }
}

export function detectorFixture(mode: "exit" | "abort" | "escape") {
  const f = fixture();
  const bin = join(f.directory, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const identity = join(f.directory, "descendant.json");
  const ready = join(f.directory, "git-ready.json");
  const stop = join(f.directory, "stop-descendant");
  const stopped = join(f.directory, "descendant-stopped.json");
  const effects = join(f.directory, "descendant-effects");
  const result = join(f.directory, "detector-result.json");
  const token = randomUUID();
  f.write(
    f.directory,
    "descendant.ts",
    `
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync, writeSync } from "node:fs";
const [identity, stop, stopped, effects, token] = process.argv.slice(2);
const group = Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim());
const evidence = JSON.stringify({ pid: process.pid, group, token });
writeSync(2, "detector stderr before inherited hold\\n");
writeFileSync(identity, evidence);
const timer = setInterval(() => appendFileSync(effects, "effect\\n"), 20);
const finish = () => {
  clearInterval(timer);
  try { writeSync(2, "late descendant stderr\\n"); } catch {}
  writeFileSync(stopped, evidence);
  process.exit(0);
};
setTimeout(finish, 15_000);
while (!existsSync(stop)) await Bun.sleep(20);
finish();
`,
  );
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, writeSync } from "node:fs";
if (!process.argv.includes("ls-remote")) throw new Error("only the detector may invoke fixture git");
const descendant = spawn(${JSON.stringify(process.execPath)}, ${JSON.stringify([
      join(f.directory, "descendant.ts"),
      identity,
      stop,
      stopped,
      effects,
      token,
    ])}, { detached: ${mode === "escape"}, stdio: ["ignore", "ignore", "inherit"] });
descendant.unref();
while (!existsSync(${JSON.stringify(identity)})) await Bun.sleep(20);
writeSync(1, ${JSON.stringify(`${f.config.baseUpstream}\t${f.config.ref}\n`)});
const group = Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim());
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, group }));
if (${JSON.stringify(mode)} === "exit") process.exit(0);
await Bun.sleep(20_000);
`,
    { mode: 0o700 },
  );
  f.write(
    f.directory,
    "detector.ts",
    `
import { existsSync, writeFileSync } from "node:fs";
import { DoriUpdater } from ${JSON.stringify(new URL("../src/update/controller.ts", import.meta.url).href)};
import { UpdateDetectionUnavailable, UpdateInterrupted } from ${JSON.stringify(new URL("../src/update/config.ts", import.meta.url).href)};
const controller = new AbortController();
const updater = new DoriUpdater(${JSON.stringify(f.config)}, () => {}, controller.signal);
const pending = updater.once("stage").then(
  () => ({ interrupted: false, unavailable: false }),
  (error) => ({ interrupted: error instanceof UpdateInterrupted, unavailable: error instanceof UpdateDetectionUnavailable }),
);
if (${JSON.stringify(mode)} !== "exit") {
  const deadline = Date.now() + 8_000;
  while (!existsSync(${JSON.stringify(ready)})) {
    if (Date.now() > deadline) throw new Error("fixture git never became ready");
    await Bun.sleep(20);
  }
  controller.abort();
}
const outcome = await pending;
writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ...outcome, state: updater.status().state }));
`,
  );
  const proc = Bun.spawn([process.execPath, join(f.directory, "detector.ts")], {
    cwd: f.directory,
    env: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: 20_000,
  });
  const stderr = new Response(proc.stderr).text();
  return {
    ...f,
    proc,
    stderr,
    ready,
    result,
    stopped,
    identity,
    effects,
    cleanup: async () => {
      writeFileSync(stop, "release only this fixture's descendant");
      await proc.exited;
      await stderr;
      if (existsSync(identity)) {
        const descendant = JSON.parse(readFileSync(identity, "utf8")) as { pid: number };
        await waitFor(() => {
          if (existsSync(stopped)) return true;
          const process = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(descendant.pid)], {
            encoding: "utf8",
            timeout: 1_000,
          });
          return process.status === 1 || (process.status === 0 && process.stdout.trim().startsWith("Z"));
        });
      }
    },
  };
}

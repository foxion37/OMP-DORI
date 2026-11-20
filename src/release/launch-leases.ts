import { createHash } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { processIdentity } from "../update/deployment-process.ts";
import { processExists } from "../update/proc.ts";
import {
  acquireConsumerLock,
  ConsumerLockBusy,
  type ConsumerPaths,
  owned,
  readJson,
  realDirectory,
  regularFile,
  saveJson,
} from "./files.ts";

type LaunchLease = { readonly version: 1; readonly pid: number; readonly startTicks: string; readonly bootId: string };

/** A short gate covers lease registration and only the final pointer transaction, never downloads or preparation. */
export const acquireLaunchGate = (paths: ConsumerPaths): (() => void) =>
  acquireConsumerLock(paths, "consumer-launch.lock");

export async function waitLaunchGate(paths: ConsumerPaths): Promise<() => void> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      return acquireLaunchGate(paths);
    } catch (error) {
      if (!(error instanceof ConsumerLockBusy) || performance.now() >= deadline) throw error;
      await Bun.sleep(25);
    }
  }
}

/** Call under the launch gate. Start identity survives shell->native exec; executable identity intentionally does not. */
export function registerConsumerLaunch(paths: ConsumerPaths, pid: number): void {
  const identity = processIdentity(pid);
  if (!identity) throw new Error("Consumer launcher process identity is unavailable");
  const lease: LaunchLease = { version: 1, pid, startTicks: identity.startTicks, bootId: identity.bootId };
  const directory = join(paths.root, "consumer-launches");
  realDirectory(directory, true);
  owned(directory);
  const key = createHash("sha256").update(JSON.stringify(lease)).digest("hex");
  const path = join(directory, `${pid}-${key}.json`);
  if (regularFile(path)) {
    if (JSON.stringify(readJson(path)) !== JSON.stringify(lease)) throw new Error("Consumer launch receipt changed");
  } else saveJson(path, lease);
}

/** Called under the launch gate; stale receipts are owned, identity-addressed and never reused. */
export function assertNoConsumerLaunches(paths: ConsumerPaths, owner?: number): void {
  const directory = join(paths.root, "consumer-launches");
  realDirectory(directory);
  if (!existsSync(directory)) return;
  owned(directory);
  for (const name of readdirSync(directory)) {
    if (!/^\d+-[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unexpected consumer launch receipt");
    const path = join(directory, name);
    const lease = readJson(path) as LaunchLease;
    if (
      !lease ||
      Object.keys(lease).sort().join() !== "bootId,pid,startTicks,version" ||
      lease.version !== 1 ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      typeof lease.startTicks !== "string" ||
      !/^\d+$/.test(lease.startTicks) ||
      typeof lease.bootId !== "string" ||
      !lease.bootId ||
      name !== `${lease.pid}-${createHash("sha256").update(JSON.stringify(lease)).digest("hex")}.json`
    )
      throw new Error("Invalid consumer launch receipt");
    const observed = processIdentity(lease.pid);
    if (!observed && processExists(lease.pid)) throw new Error("Uncertain consumer launcher identity holds activation");
    if (observed?.startTicks === lease.startTicks && observed.bootId === lease.bootId) {
      if (lease.pid !== owner) throw new Error(`Live consumer launch PID ${lease.pid} holds release activation`);
    } else unlinkSync(path);
  }
}

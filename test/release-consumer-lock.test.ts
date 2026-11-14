import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { acquireConsumerLock } from "../src/release/files.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { fixture } from "./release-consumer-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux("a delayed stale contender preserves the winner's live lock and retained tombstone", () => {
  const { paths } = fixture();
  const lock = join(paths.root, "consumer.lock");
  const owner = join(lock, "owner.json");
  const identity = processIdentity(process.pid)!;
  const staleOwner = JSON.stringify({ ...identity, startTicks: `${BigInt(identity.startTicks) + 1n}` });
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(owner, staleOwner, { mode: 0o600 });

  const readFileSync = fs.readFileSync;
  let scheduled = false;
  let releaseA: (() => void) | undefined;
  let releaseB: (() => void) | undefined;
  let ownerA: string | undefined;
  let inodeA: number | undefined;
  const read = spyOn(fs, "readFileSync").mockImplementation(
    new Proxy(readFileSync, {
      apply(target, receiver, args) {
        const bytes = Reflect.apply(target, receiver, args);
        if (args[0] === owner && !scheduled) {
          scheduled = true;
          // B has read the real stale bytes; A recovers and claims before B receives them.
          releaseA = acquireConsumerLock(paths);
          ownerA = readFileSync(owner, "utf8");
          inodeA = fs.lstatSync(lock).ino;
        }
        return bytes;
      },
    }),
  );
  try {
    expect(() => {
      releaseB = acquireConsumerLock(paths);
    }).toThrow();
    expect(scheduled).toBe(true);
    expect(releaseA).toBeDefined();
    expect(releaseB).toBeUndefined();
    if (releaseA === undefined || ownerA === undefined || inodeA === undefined)
      throw new Error("The winning acquisition did not record its lock ownership");
    const currentOwner = fs.readFileSync(owner, "utf8");
    expect(currentOwner).toBe(ownerA);
    expect(JSON.parse(currentOwner)).toEqual(identity);
    expect(fs.lstatSync(lock).ino).toBe(inodeA);

    const tombstones = fs.readdirSync(paths.root).filter((name) => name.startsWith("consumer.lock.stale-"));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatch(/^consumer\.lock\.stale-[a-f0-9]{64}$/);
    const tombstoneOwner = join(paths.root, tombstones[0]!, "owner.json");
    expect(fs.readFileSync(tombstoneOwner, "utf8")).toBe(staleOwner);

    releaseA();
    releaseA = undefined;
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readFileSync(tombstoneOwner, "utf8")).toBe(staleOwner);
  } finally {
    read.mockRestore();
    releaseA?.();
  }
});

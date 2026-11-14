import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseManifest } from "../src/release/types.ts";
import { object } from "../src/update/config.ts";
import { saveJson } from "../src/update/state.ts";

type Journal = {
  version: 1;
  commit: string;
  sourceHash: string;
  tag: string;
  prerelease: boolean;
  pending?: string;
};

/** Persist intent before every write; uncertain effects are only read back, never automatically replayed. */
export class ReleaseJournal {
  private readonly path: string;
  private readonly state: Journal;

  constructor(directory: string, manifest: ReleaseManifest) {
    this.path = join(directory, ".release-publication.json");
    let raw: unknown;
    try {
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("Publication journal must be a regular file");
        raw = JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const identity = {
      version: 1 as const,
      commit: manifest.commit,
      sourceHash: manifest.source.hash,
      tag: manifest.tag,
      prerelease: manifest.prerelease,
    };
    if (raw !== undefined) {
      if (!object(raw)) throw new Error("Publication journal is malformed");
      const observed = raw;
      if (
        Object.entries(identity).some(([key, value]) => observed[key] !== value) ||
        (observed["pending"] !== undefined && typeof observed["pending"] !== "string")
      ) {
        throw new Error("Publication journal does not match this committed release");
      }
    }
    this.state = raw === undefined ? identity : (raw as Journal);
  }

  get pending(): string | undefined {
    return this.state.pending;
  }

  confirmed(): void {
    delete this.state.pending;
    saveJson(this.path, this.state);
  }

  async effect(operation: string, write: () => Promise<unknown>, confirmed: () => Promise<boolean>): Promise<void> {
    if (this.state.pending) throw new Error(`Unresolved publication intent: ${this.state.pending}`);
    this.state.pending = operation;
    saveJson(this.path, this.state);
    try {
      await write();
    } catch {
      // A failed transport does not establish whether GitHub applied the write.
    }
    if (!(await confirmed())) {
      throw new Error(`Ambiguous publication ${operation}; intent retained, inspect GitHub instead of replaying it`);
    }
    this.confirmed();
  }
}

/** Kernel ownership survives parent crashes without a stale PID lock; workflow concurrency serializes tag runs. */
export async function lockPublication(directory: string): Promise<() => Promise<void>> {
  const holder = Bun.spawn(
    [
      "flock",
      "--nonblock",
      join(directory, ".release-publication.lock"),
      "sh",
      "-c",
      "printf 'locked\\n'; cat >/dev/null",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const reader = holder.stdout.getReader();
  const ready = await reader.read();
  if (ready.done || Buffer.from(ready.value).toString() !== "locked\n") {
    holder.stdin.end();
    await holder.exited;
    throw new Error("Another publisher owns this distribution or flock is unavailable");
  }
  reader.releaseLock();
  return async () => {
    holder.stdin.end();
    await holder.exited;
  };
}

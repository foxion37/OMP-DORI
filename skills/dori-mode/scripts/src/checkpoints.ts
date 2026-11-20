import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { takeLock } from "./checkpoint-lock.ts";
import { LANE_KEY } from "./registry.ts";

export type CheckpointInput = {
  readonly step: string;
  readonly result: string;
  readonly evidence: readonly string[];
  readonly remoteEffects: readonly string[];
};
export type Checkpoint = CheckpointInput & { readonly key: string; readonly at: string };
export class CheckpointError extends Error {}

const validate = (input: CheckpointInput): void => {
  if (
    typeof input.step !== "string" ||
    !input.step.trim() ||
    typeof input.result !== "string" ||
    !input.result.trim() ||
    !Array.isArray(input.evidence) ||
    !input.evidence.every((v) => typeof v === "string") ||
    !Array.isArray(input.remoteEffects) ||
    !input.remoteEffects.every((v) => typeof v === "string")
  ) {
    throw new CheckpointError("checkpoint requires step, result, evidence[], and completed remoteEffects[]");
  }
};
const payload = (value: CheckpointInput): string =>
  JSON.stringify({
    step: value.step,
    result: value.result,
    evidence: value.evidence,
    remoteEffects: value.remoteEffects,
  });

export class Checkpoints {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new CheckpointError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "checkpoints.jsonl");
  }

  read(key: string): Checkpoint[] {
    const path = this.path(key);
    if (!existsSync(path)) return [];
    const steps = new Set<string>();
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim())
      .map(({ line, index }) => {
        try {
          const value = JSON.parse(line) as Checkpoint;
          validate(value);
          if (
            value.key !== key ||
            typeof value.at !== "string" ||
            !Number.isFinite(Date.parse(value.at)) ||
            steps.has(value.step)
          ) {
            throw new CheckpointError("invalid key, timestamp, or duplicate step");
          }
          steps.add(value.step);
          return value;
        } catch (error) {
          throw new CheckpointError(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }

  /** Take the journal's writer lock (see takeLock) and return its release; a live writer's lock is refused. */
  lock(key: string, now: number): () => void {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    const held = takeLock(`${path}.lock`, now, (m) => new CheckpointError(`checkpoint writer lock of ${key} ${m}`));
    if (typeof held === "string") throw new CheckpointError(`checkpoint writer locked: ${key} (${held})`);
    return held;
  }

  write(key: string, input: CheckpointInput, now: number): { checkpoint: Checkpoint; unchanged: boolean } {
    validate(input);
    const path = this.path(key);
    const at = new Date(now).toISOString();
    // Never replay a remote effect just because the process restarted: the step check runs under the lock.
    const release = this.lock(key, now);
    try {
      const recorded = this.read(key);
      const previous = recorded.find((entry) => entry.step === input.step);
      if (previous) {
        if (payload(previous) !== payload(input))
          throw new CheckpointError(`conflicting checkpoint step: ${input.step}`);
        return { checkpoint: previous, unchanged: true };
      }
      // A receipt names one completed remote effect; recording it under a second step would read as a second effect.
      for (const entry of recorded) {
        const repeated = input.remoteEffects.find((receipt) => entry.remoteEffects.includes(receipt));
        if (repeated !== undefined)
          throw new CheckpointError(`remote effect ${repeated} already recorded by step ${entry.step}`);
      }
      const checkpoint: Checkpoint = { key, at, ...JSON.parse(payload(input)) };
      const created = !existsSync(path);
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(checkpoint)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // A new journal's directory entry must be durable too, or a crash could lose the first checkpoint after it was acknowledged.
      if (created && process.platform !== "win32") {
        const dir = openSync(dirname(path), "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      return { checkpoint, unchanged: false };
    } finally {
      release();
    }
  }
}

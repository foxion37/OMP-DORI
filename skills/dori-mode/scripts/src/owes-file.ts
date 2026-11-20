import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { takeLock } from "./checkpoint-lock.ts";

const KEEP_LINES = 200;
const RETRY_MS = 50;

export const readLines = (path: string): string[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
};

type Mutation<T> = { readonly lines: readonly string[]; readonly value: T };

/** The callback and publication are synchronous: ownership never spans an await. */
export const updateLines = async <T>(
  path: string,
  update: (previous: string[]) => Mutation<T>,
  signal?: AbortSignal,
): Promise<T> => {
  for (;;) {
    signal?.throwIfAborted();
    const release = takeLock(`${path}.lock`, Date.now(), (message) => new Error(`owes lock ${message}`), {
      keepLiveOwner: true,
    });
    if (typeof release === "string") {
      try {
        await delay(RETRY_MS, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
      continue;
    }
    try {
      signal?.throwIfAborted();
      const previous = readLines(path);
      const { lines, value } = update(previous);
      if (lines !== previous) {
        const temporary = `${path}.${process.pid}.tmp`;
        // Joining frames even an unterminated corrupt tail separately from the newly admitted records.
        writeFileSync(temporary, `${lines.slice(-KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      }
      return value;
    } finally {
      release();
    }
  }
};

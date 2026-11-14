import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { alive } from "../../skills/dori-mode/scripts/src/checkpoint-lock.ts";
import { object, UpdateError } from "./config.ts";
import { digest } from "./source.ts";
import type { UpdateLock } from "./types.ts";

/**
 * Immutable claims serialize stale-lock recovery. Never reuse/delete a claim: after a recovering controller dies,
 * its successor claims the next generation, so two reapers cannot unlink a newly acquired controller lock.
 */
export function claimPromotionRecovery(root: string, previous: UpdateLock, claim: UpdateLock): boolean {
  const directory = join(root, "promotion-lock-claims");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const request = join(directory, `${claim.nonce}.pending`);
  const fd = openSync(request, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(claim));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let predecessor = previous.nonce;
  const visited = new Set<string>();
  try {
    for (;;) {
      if (visited.has(predecessor)) throw new UpdateError("promotion recovery claim chain is malformed");
      visited.add(predecessor);
      const path = join(directory, `${digest(predecessor)}.json`);
      try {
        linkSync(request, path);
        const parent = openSync(directory, "r");
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !object(raw) ||
        raw["version"] !== 1 ||
        !Number.isSafeInteger(raw["pid"]) ||
        Number(raw["pid"]) <= 0 ||
        typeof raw["host"] !== "string" ||
        typeof raw["nonce"] !== "string"
      ) {
        throw new UpdateError("promotion recovery claim is malformed; retained for inspection");
      }
      if (raw["host"] !== hostname() || alive(Number(raw["pid"]))) return false;
      predecessor = raw["nonce"];
    }
  } finally {
    if (existsSync(request)) unlinkSync(request);
  }
}

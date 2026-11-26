import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueuedMessage } from "./store-types.ts";

/**
 * A harness stop retires the lead's inbox with the session, so an owner message that arrived while the lead was mid-turn
 * dies with it: the owner wrote, got no answer, and nothing said so. The stop carries the messages the lead never tried
 * to read to a file beside the inboxes, and the next `up` hands them to the new lead (2026-11-26: the SA thread lost two
 * messages this way in one restart).
 *
 * Only messages with no delivery attempt are carried. A message whose delivery was ambiguous may already be in the old
 * session, and the new one would answer it twice; held entries stay for a person (`cataly harness inbox list`).
 */

export type CarriedMessage = { at: number; from: string; text: string };

/** The carry file every start and stop must agree on. */
export const leadCarryPath = (root: string): string => join(root, "inbox", "lead-carry.jsonl");

const isCarried = (v: unknown): v is CarriedMessage => {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Partial<CarriedMessage>;
  return typeof m.at === "number" && Number.isFinite(m.at) && typeof m.from === "string" && typeof m.text === "string";
};

/**
 * Adds the never-attempted messages to the carry file and returns how many it holds. A carry an earlier stop wrote is
 * kept and merged (a failed `up` can be followed by a second stop before anything restored it); one message stays one
 * line however many stops carried it.
 */
export function carryLeadInbox(root: string, queued: readonly QueuedMessage[]): number {
  const path = leadCarryPath(root);
  const existing = readLeadCarry(root);
  const added = queued.filter(
    (m) => m.attempt === undefined && !existing.some((c) => c.at === m.at && c.from === m.from && c.text === m.text),
  );
  if (added.length === 0) return existing.length;
  const merged = [...existing, ...added.map((m) => ({ at: m.at, from: m.from, text: m.text }))].sort(
    (a, b) => a.at - b.at,
  );
  mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.${process.pid}.tmp`, `${merged.map((m) => JSON.stringify(m)).join("\n")}\n`, {
    mode: 0o600,
  });
  renameSync(`${path}.${process.pid}.tmp`, path);
  return merged.length;
}

/** The carried messages, oldest first. A torn line is skipped rather than blocking the others. */
export function readLeadCarry(root: string): CarriedMessage[] {
  let raw: string;
  try {
    raw = readFileSync(leadCarryPath(root), "utf8");
  } catch {
    return [];
  }
  const out: CarriedMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isCarried(value)) out.push(value);
    } catch {
      // A damaged line is one lost message, not a failed restart.
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Carried messages the lead's inbox does not already hold: a resumed session kept its own queue. */
export function unheldCarry(carried: readonly CarriedMessage[], held: readonly QueuedMessage[]): CarriedMessage[] {
  return carried.filter((m) => !held.some((q) => q.at === m.at && q.text === m.text));
}

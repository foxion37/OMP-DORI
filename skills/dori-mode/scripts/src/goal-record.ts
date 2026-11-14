import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { ChosenRuntimes, Runner } from "./run.ts";
import { sessionDirFor, sessionFileStart, trustedPaneState } from "./session-id.ts";

// A launch owns a goal only when its first user message names the lane and the session was created by this launch.
// OMP reports its live goal through the extension; custom omo agents keep their upstream goal-record path.
const CLOCK_SLACK_MS = 5_000;

type Entry = { readonly type?: unknown; readonly message?: { readonly role?: unknown; readonly content?: unknown } };

const firstUserText = (jsonl: string): string => {
  for (const line of jsonl.split("\n")) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a blank line, or the last line while the agent is still writing it
    }
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? content.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";
  }
  return "";
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

type OmpGoal = {
  readonly run: Runner;
  readonly rts: ChosenRuntimes;
  readonly stateDir: string;
  readonly ref: SessionRef;
};

/** The current launch's active goal, independent of terminal width or quoted status text. */
export const laneGoalActive = async (
  sessionsDir: string,
  cwd: string,
  key: string,
  since: number,
  omp?: OmpGoal,
): Promise<boolean> => {
  const lane = `You are the ${key} lane`;
  if (omp) {
    const state = await trustedPaneState(omp.run, omp.stateDir, omp.ref, omp.rts);
    if (!state || state.role !== "lane" || state.goal?.status !== "active") return false;
    if (sessionDirFor(sessionsDir, state.cwd) !== sessionDirFor(sessionsDir, cwd)) return false;
    const dir = sessionDirFor(sessionsDir, cwd);
    let path = state.sessionFile;
    if (!path) {
      try {
        const name = readdirSync(dir).find((name) => sessionFileStart(name)?.id === state.sessionId);
        if (name) path = join(dir, name);
      } catch {
        return false;
      }
    }
    if (!path) return false;
    const session = sessionFileStart(basename(path));
    return (
      !!session &&
      session.id === state.sessionId &&
      session.at >= since - CLOCK_SLACK_MS &&
      firstUserText(readText(path) ?? "").includes(lane)
    );
  }
  const dir = join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false; // the agent has not written its session store yet
  }
  for (const name of names) {
    const session = sessionFileStart(name);
    if (!session || session.at < since - CLOCK_SLACK_MS) continue;
    if (!firstUserText(readText(join(dir, name)) ?? "").includes(lane)) continue;
    const record = readText(join(dir, "extensions", "goal", `${encodeURIComponent(session.id)}.json`));
    if (record === undefined) return false;
    try {
      return (JSON.parse(record) as { goal?: { status?: unknown } | null }).goal?.status === "active";
    } catch {
      return false; // a record caught mid-write reads as no goal here; the next check reads it again
    }
  }
  return false;
};

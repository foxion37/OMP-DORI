// get_status: read-only lane and report lookups over the lead's own registry, sync and report journals.
import type { FlowDeps } from "../done-flow.ts";
import { type Progress, Reports, reportLine } from "../reports.ts";
import { iso } from "../run.ts";
import { syncRegistry } from "../sync.ts";
import type { ToolResult } from "./types.ts";

export type StatusSource = "lanes" | "reports";
type Part = { readonly ok: boolean; readonly result: string };

const LANES_CHARS = 3000;
const REPORT_CHARS = 350;
const REPORT_LANES = 8;

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const reason = (e: unknown): string => clip(e instanceof Error ? e.message : String(e), 200);

/** `dori sync` without writing: every open lane with its live session, plus agents no lane owns. */
const lanes = async (deps: FlowDeps): Promise<Part> => {
  try {
    const synced = await syncRegistry(deps, false);
    const since = new Map((await deps.registry.open()).map((lane) => [lane.key, lane.history?.at(-1)?.at]));
    const rows = [...synced.rows, ...synced.unregistered].map((row) => {
      const at = since.get(row.key);
      return `- ${row.key} ${row.status}${at ? ` since ${at}` : ""} pane=${row.pane} thread=${row.thread}`;
    });
    const drift = synced.drift.length ? `\ndrift: ${synced.drift.join("; ")}` : "";
    const body = rows.length ? rows.join("\n") : "no open lanes";
    return { ok: true, result: clip(`read at ${iso(deps.clock)}\n${body}${drift}`, LANES_CHARS) };
  } catch (e) {
    return { ok: false, result: `lanes unavailable at ${iso(deps.clock)}: ${reason(e)}` };
  }
};

/** The latest report of each recently active lane, newest first, each with its own timestamp. */
const reports = async (deps: FlowDeps): Promise<Part> => {
  try {
    const journal = new Reports(deps.config.stateDir);
    const found: { readonly key: string; readonly progress: Progress }[] = [];
    const unreadable: string[] = [];
    for (const lane of (await deps.registry.scan()).lanes) {
      try {
        const progress = journal.read(lane.key, { generation: lane.lifecycleEpoch });
        if (progress) found.push({ key: lane.key, progress });
      } catch {
        unreadable.push(lane.key);
      }
    }
    const lines = found
      .sort((a, b) => Date.parse(b.progress.lastEvent.at) - Date.parse(a.progress.lastEvent.at))
      .slice(0, REPORT_LANES)
      .map(({ key, progress }) => {
        const last = progress.lastReport;
        if (last)
          return `- ${last.at} ${reportLine({ ...last, text: clip(last.text, REPORT_CHARS) })} (${progress.state})`;
        return `- ${progress.lastEvent.at} [ACTIVITY] ${key} | ${progress.state} | ${clip(progress.lastEvent.text, REPORT_CHARS)}`;
      });
    const broken = unreadable.length ? `\nunreadable journals: ${unreadable.join(", ")}` : "";
    const body = lines.length ? lines.join("\n") : "no lane reports";
    return { ok: true, result: `read at ${iso(deps.clock)}\n${body}${broken}` };
  } catch (e) {
    return { ok: false, result: `reports unavailable at ${iso(deps.clock)}: ${reason(e)}` };
  }
};

/** Every requested source at once; each part keeps its own read time, the combined result labels each source. */
export const getStatus = async (deps: FlowDeps, what: readonly StatusSource[]): Promise<ToolResult> => {
  const read = { lanes, reports };
  const parts = await Promise.all(what.map((source) => read[source](deps)));
  return {
    ok: parts.every((part) => part.ok),
    result: parts.map((part, i) => `[${what[i]}] ${part.result}`).join("\n"),
    parts: Object.fromEntries(what.map((source, i) => [source, parts[i]!])),
  };
};

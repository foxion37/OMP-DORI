import { scrubForThread } from "./freshness-report.ts";
import type { StatusSnapshot } from "./status.ts";

const line = (text: string) => Bun.stripANSI(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

export const renderStatus = (snapshot: StatusSnapshot): string => {
  const lines: string[] = [];
  let thread: string | undefined;
  for (const lane of snapshot.lanes) {
    if (lane.thread !== thread) {
      thread = lane.thread;
      lines.push(`THREAD ${line(thread)}`);
    }
    const state = lane.runtime;
    const elapsed = Math.max(
      0,
      Math.floor((Date.parse(lane.closedAt ?? snapshot.observedAt) - Date.parse(lane.openedAt)) / 60_000),
    );
    lines.push(
      `  ${lane.key} ${lane.status} ${Number.isFinite(elapsed) ? `${elapsed}m` : "elapsed unknown"} | agent=${state?.agentStatus ?? "unknown"} goal=${state?.goal.status ?? "unknown"} approval=${state ? state.approvalPending : "unknown"} decisions=${lane.decisions ?? "unknown"}`,
    );
    if (state) lines.push(`    runtime observed ${state.updatedAt}`);
    const progress = lane.progress;
    if (progress) {
      lines.push(`    progress=${progress.state} at=${progress.lastEvent.at}`);
      const report = progress.lastReport;
      if (report) lines.push(`    last ${report.at} ${report.kind}: ${line(report.text)}`);
    } else lines.push("    progress=unknown (no readable journal)");
    if (lane.checkpoint)
      lines.push(`    checkpoint ${lane.checkpoint.at} ${line(lane.checkpoint.step)}: ${line(lane.checkpoint.result)}`);
    lines.push(
      `    last sweep note=${line(lane.lastSweepNote ?? "unrecorded")} nudge=${lane.lastNudgeAt ?? "none"} post=${lane.lastPostedAt ?? "none"}`,
    );
    for (const error of lane.errors) lines.push(`    WARN ${error}`);
  }
  if (!snapshot.lanes.length)
    lines.push(snapshot.registryIncomplete ? "LANES unknown (registry incomplete)" : "LANES none open");
  lines.push(`DECISIONS ${snapshot.decisions ?? "unknown"} open`);
  const m = snapshot.monitors;
  lines.push(
    `MONITORS ${m.recorded ?? "unknown"} recorded, ${m.suspended ?? "unknown"} suspended, ${m.expired ?? "unknown"} expired (metadata only; liveness unverified)`,
  );
  for (const error of snapshot.errors) lines.push(`WARN ${error}`);
  return lines.join("\n");
};

const evidenceLink = (link: string): string => {
  // Only a terminal quote, optionally followed by closing prose punctuation, ends a quoted link.
  const url = link.startsWith("'") ? link.slice(1).replace(/'[\p{Pe}\p{Pf},.;:!?…]*$/u, "") : link;
  // Do not reinterpret an empty authority or backslashes as a public web path.
  if (!/^https?:\/\/[^/]/i.test(url) || url.includes("\\")) return "(invalid web link)";
  try {
    const { origin, pathname } = new URL(url);
    // Never forward userinfo or parameters, regardless of their name or encoding.
    return `${origin}${pathname}`;
  } catch {
    return "(invalid web link)";
  }
};

/** Bounded plain text: one message, no paths/pane IDs from reports and no mention notifications. */
export const renderBoard = (snapshot: StatusSnapshot, home: string, limit: number): string => {
  // An unquoted local path has no reliable whitespace boundary. Keep web links, but omit the rest of its text segment.
  const clean = (text: string) =>
    line(text)
      .split(/((?<![\p{L}\p{N}_./\\])'?https?:\/\/[^\s<>"]+)/giu)
      .map((part, index) =>
        index % 2
          ? evidenceLink(part)
          : scrubForThread(
              part
                .split(home)
                .join("~/")
                .replace(/(?:~[\\/]|(?<![\p{L}\p{N}_./\\])(?:[A-Za-z]:[\\/]|\\\\|\/))[\s\S]*/u, "(local path)"),
              home,
            ),
      )
      .filter(Boolean)
      .join(" ")
      .replace(/@/g, "(at)")
      .replace(/\$\(/g, "$ (");
  const lines = [
    `Dori status | ${snapshot.lanes.length} ${snapshot.registryIncomplete ? "readable lanes (registry incomplete)" : "lanes"} | ${snapshot.decisions ?? "unknown"} decisions open`,
  ];
  let shown = 0;
  for (const lane of snapshot.lanes) {
    const report = lane.progress?.lastReport;
    const summary = `${clean(lane.key)} | ${lane.status} | agent ${lane.runtime?.agentStatus ?? "unknown"} | ${lane.runtime?.approvalPending ? "approval pending" : (lane.progress?.state ?? "progress unknown")}`;
    const detail = report ? `\n  ${report.at} ${report.kind}: ${clean(report.text).slice(0, 240)}` : "";
    if ([...lines, summary + detail].join("\n").length > limit - 100) break;
    lines.push(summary + detail);
    shown++;
  }
  if (shown < snapshot.lanes.length) lines.push(`${snapshot.lanes.length - shown} more lanes: use dori status`);
  if (snapshot.errors.length || snapshot.lanes.some((l) => l.errors.length))
    lines.push("WARN incomplete observations: use dori status");
  return lines.join("\n");
};

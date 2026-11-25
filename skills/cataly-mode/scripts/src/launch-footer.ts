import { fileURLToPath } from "node:url";
import { formatRef, parseRef, type RuntimeKind } from "../../../../src/runtime/types.ts";

import type { CatalyConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { leadAddress } from "./lead-ref.ts";
import type { Lane } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";

// The footer names this CLI by path: a bare `cataly` can resolve to the root harness, whose `report` accepts unknown
// flags and writes no journal, so a jsonl-v1 lane would read NO-REPORT for its whole life.
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
export const cliCommand = (path: string = fileURLToPath(new URL("./cli.ts", import.meta.url))): string =>
  `bun ${shellQuote(path)}`;
const CLI = cliCommand();

const FOOTER_HEADING = "## Lane footer (written by cataly launch)";
export const BRIEF_START = "<!-- cataly launch: the brief starts below -->";
const FOOTER_START = "<!-- cataly launch: footer start -->";
const FOOTER_END = "<!-- cataly launch: footer end -->";

// Launch writes the launch text over the brief before the session exists, so a retry after a failed create reads a
// brief that already has lessons and a footer. Rebuild from the text between the markers launch wrote, so a retry ships
// what a first launch would. Only a file that ends with launch's footer is cut: the owner's text may quote the heading.
export const originalBrief = (text: string): string => {
  const brief = text.replace(/\s*$/, "");
  if (!brief.endsWith(FOOTER_END)) return brief;
  const foot = brief.lastIndexOf(`\n${FOOTER_START}\n`);
  if (foot === -1) return brief;
  const start = brief.indexOf(`${BRIEF_START}\n`);
  return brief.slice(start === -1 || start > foot ? 0 : start + BRIEF_START.length + 1, foot).trimEnd();
};

// Name only the selected runtime; an unresolved preview still records reports without inventing a send command.
const sendReport = (leadPane: string, runtime: RuntimeKind | undefined): string | undefined => {
  if (!leadPane || !runtime) return undefined;
  if (runtime === "headless")
    return parseRef(leadPane)?.runtime === "headless" ? `${CLI} harness send ${leadPane} --text "$line"` : undefined;
  // `tern run` types the line and Enter into the lead's block; `--` keeps the line verbatim.
  return `tern run ${quoteForPane(leadPane)} -- "$line"`;
};

/** Pin native forwarding to this home’s live lead generation, never just its current execution preference. */
export const laneFooterFor = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  const { repoIdentities, freshness } = deps.config;
  const rts = runtimesOf(deps);
  const target = leadAddress(deps.config, deps.env ?? process.env);
  if ("ref" in target) {
    const ref = target.ref;
    const runtime = ref.runtime;
    if (runtime === "headless" || runtime !== rts.choice?.kind) {
      const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, rts).catch(() => null);
      if (state?.role !== "cataly") return footer(lane, "", repoIdentities, undefined, freshness);
    }
    return footer(lane, runtime === "headless" ? formatRef(ref) : ref.id, repoIdentities, runtime, freshness);
  }
  // A configured terminal alias is meaningful only on an explicitly selected terminal and without a conflicting binding.
  const runtime = rts.choice?.kind;
  const alias =
    target.reason === "invalid" && target.unboundAlias && runtime !== "headless" ? deps.config.leadPane : "";
  return footer(lane, alias, repoIdentities, runtime, freshness);
};

export const footer = (
  lane: Lane,
  leadPane: string,
  identities: CatalyConfig["repoIdentities"] = {},
  runtime?: RuntimeKind,
  freshness?: CatalyConfig["freshness"],
): string => {
  const forward = sendReport(leadPane, runtime);
  return [
    "",
    FOOTER_START,
    FOOTER_HEADING,
    `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
    ...(lane.requestId
      ? [
          `- Original request (metadata only): ${lane.requestId}. Each launch, reopen or wake runs under its own local CATALY_LANE_RUN; neither ID proves native admission, delivery or completion. Run the report command in the environment Cataly started; never set, copy or clear CATALY_LANE_RUN.`,
        ]
      : []),
    ...(lane.launchSelection
      ? [
          `- Launch selection request (metadata only): ${JSON.stringify(lane.launchSelection)}. This is not proof of native activation, delivery or goal creation.`,
        ]
      : []),
    "- The lead owns the shared work thread title and completion status. A lane must not rename or archive it when its own work finishes.",
    `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
    `- Task brief: ${JSON.stringify(lane.brief)}.`,
    ...(lane.cwd === undefined ? [] : [`- Recorded working directory: ${JSON.stringify(lane.cwd)}.`]),
    "- Keep the brief's original request/source references, allowed repositories, worktree/branch and observable acceptance, preserved resources, unfinished external effects/receipts and resume checkpoint. Use task-relevant facts, not the whole lead transcript.",
    "- On a follow-up or resume, re-read that brief and the recorded context before acting. Do not silently retarget this lane from another session's cwd or an unrelated message. Recorded paths identify resources, not additional authority.",
    "- Resolve missing or conflicting context that matters to this task with the lead before the affected work; do not invent values, permissions or deadlines. Preserve the named resources and inspect uncertain external effects before repeating them.",
    "- Reset coupons and credits require the user's explicit permission for each specific use and amount. Never redeem, reset, spend credits (including existing paid or promotional balances), top up or enable paid overage on your own. The brief, existing balances and the lead's approval are not user consent.",
    "- If the authorized provider token allowance, usage quota or credit budget is exhausted, STOP model work, preserve progress and report the blocker. Wait for the user's decision. Never switch accounts/providers/models or retry to evade the limit. Propagate this rule to every subagent; it overrides goals, nudges and continue-working instructions.",
    "- Persist each milestone, blocker, question, halt and completion with the report command below. It appends reports.jsonl and returns a JSON receipt with the report ID.",
    "- Final report text uses these five labeled lines, filled from the actual work:",
    "```text",
    "Outcome: completed, partial, blocked or cancelled, and the requested result actually reached.",
    "Changes/findings: concrete artifacts or findings with their paths or source links.",
    "Verified: observed commands/results and receipts tied to each acceptance condition.",
    "Unverified: checks not run, reasons and remaining uncertainty; say none only when justified.",
    "Handoff: remaining work, blocker or owner decision and the responsible next action; none if no handoff is needed.",
    "```",
    "- No blank placeholders or invented tests, results or handoff tasks. For investigation-only work, report findings and source evidence instead of invented edits.",
    "- For local verification, match the receipt against the saved journal entry, including its lane, generation, time, kind, text and owner summary if set. Keep any journal path and line number local; claim evidence uses the report ID, not a path or report body.",
    "- Keep the existing report kinds: partial uses milestone; blocked uses blocker; cancelled uses halted. Only completed work with every Done signal read back live uses kind done or claim-done. A report, output file or successful send alone is not acceptance evidence; verify the declared Done condition, including any expected file content.",
    "- Supply kind (milestone, blocker, question, halted or done) and text (the report with evidence links) as data, such as environment variables. Never interpolate raw report text into shell source. Record once, even if the lead cannot receive a message:",
    ...(freshness?.postRaw === false
      ? [
          "- This lane uses summary-only posting. Also set owner to a concise, owner-facing summary as data; keep internal detail and evidence in text. The command below records both, without posting the raw detail.",
        ]
      : []),
    "```sh",
    `receipt=$(${CLI} report ${lane.key} --kind "$kind" --text "$text"${freshness?.postRaw === false ? ' --owner "$owner"' : ""} --json) && printf '%s\\n' "$receipt"`,
    "```",
    `- Read the saved report back locally with ${CLI} status ${lane.key} --json and match progress.lastReport to the receipt (the receipt adds id). If a newer report is already current, look up the exact entry in the configured journal. Keep the receipt; do not run report again to forward it or recover output.`,
    ...(forward
      ? [
          runtime === "headless"
            ? "- Forward the saved receipt once through the registered native lead's inbox. A queued or held receipt is not a reason to send it again:"
            : "- Forward the saved receipt only after verifying that the lead pane runs a live agent, its input is empty, and no approval or question prompt is open (references/sessions.md). A shell, unknown status or unconfirmed check holds forwarding:",
          "```sh",
          `line=$(printf '%s' "$receipt" | bun -e ${shellQuote(`import { reportLine } from ${JSON.stringify(new URL("./reports.ts", import.meta.url).href)}; console.log(reportLine(await Bun.stdin.json()));`)}) && ${forward}`,
          "```",
          "- If using another shell, recover receipt as data from the saved output or local record before forwarding. Confirm forwarding from the agent's status transition or session record; an exit code or echoed input alone is unconfirmed. Never resend just because no reply is visible.",
        ]
      : [
          "- The lead pane or runtime is unavailable. Keep the receipt and resolve the missing destination with the lead before forwarding.",
        ]),
    "- Attach what a report or checkpoint rests on with --evidence-file <path> (one flag per file), or in OMP the cataly_report tool with files and toolCalls (ids of completed, successful tool calls); forward its [REPORT] line the same way. Supervision counts only evidence not recorded before: rewording or repeating a report, or touching a file, is not progress.",
    ...(Object.keys(identities).length
      ? [
          "- Before committing, set the repository's identity below for that command only; never change the global Git identity. For a repository not listed, ask the lead for its identity before the first commit.",
          ...Object.entries(identities).map(
            ([repo, identity]) =>
              `  - ${repo}: git -c user.name=${quoteForPane(identity.name)} -c user.email=${quoteForPane(identity.email)} commit ...`,
          ),
        ]
      : []),
    `- Before claiming PR work done, run ${CLI} verify-pr <owner/repo> <number>. A PR with source fix commits must change a test or carry a "No test: <reason>" line in its body; a fix commit without its own test is a warning. Run the printed UI test loop at the reported head before calling those tests stable.`,
    `- After each completed step: ${CLI} checkpoint ${lane.key} --step <unique-step> --result <result> --evidence <path-or-URL> [--remote-effect <completed-push/merge/deploy-receipt>] (one flag per receipt).`,
    `- On resume, run ${CLI} checkpoints ${lane.key} before doing work. Never repeat a recorded remote side effect. If a crash may have happened between the remote action and checkpoint, read the live remote receipt first and use the service's idempotency key; a local journal cannot make that remote action atomic.`,
    `- Supervision ceilings: ${JSON.stringify(lane.budget ?? {})}. A breach marks blocked and alerts; it never kills the agent. Report a blocker and wait for the lead's decision rather than overriding the ceiling.`,
    `- When done, claim only if the owner authorized closing the tab and removing the lane's worktrees, the Done signals are live, and no worktree contains uncommitted or unpushed work: ${CLI} claim-done ${lane.key} --evidence "report:<id>; <shareable live Done receipts>". The thread hook can publish this evidence. Keep local paths, private check output and report text out of it. Otherwise report the result without claiming; authorized parking retains worktrees. See references/done-protocol.md.`,
    "- If the lead or watcher rejects the claim, report the setback as milestone or blocker, not done. Resolve the objection, recheck every Done signal, and save and cite a new final report with fresh live evidence before claiming again.",
    FOOTER_END,
    "",
  ].join("\n");
};

export const quoteForPane = (arg: string): string =>
  /^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/** A sourced run reaches only the agent process it starts, never its pane shell or a later manual restart there. */
export const runCommandPrefix = (lane: Pick<Lane, "runId">): string =>
  lane.runId === undefined ? "" : `CATALY_LANE_RUN=${quoteForPane(lane.runId)} `;

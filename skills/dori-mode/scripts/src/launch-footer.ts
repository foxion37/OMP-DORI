import { fileURLToPath } from "node:url";

import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";

// The footer names this CLI by path: a bare `dori` can resolve to the root harness, whose `report` accepts unknown
// flags and writes no journal, so a jsonl-v1 lane would read NO-REPORT for its whole life.
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
export const cliCommand = (path: string = fileURLToPath(new URL("./cli.ts", import.meta.url))): string =>
  `bun ${shellQuote(path)}`;
const CLI = cliCommand();

const FOOTER_HEADING = "## Lane footer (written by dori launch)";
export const BRIEF_START = "<!-- dori launch: the brief starts below -->";
const FOOTER_START = "<!-- dori launch: footer start -->";
const FOOTER_END = "<!-- dori launch: footer end -->";

// startLane writes the launch text over the brief before the tab exists, so a retry after a failed tab create reads a
// brief that already has lessons and a footer. Rebuild from the text between the markers launch wrote, so a retry ships
// what a first launch would. Only a file that ends with launch's footer is cut: the owner's text may quote the heading.
export const originalBrief = (text: string): string => {
  const brief = text.replace(/\s*$/, "");
  const foot = brief.endsWith(FOOTER_END) ? brief.lastIndexOf(`\n${FOOTER_START}\n`) : -1;
  if (foot === -1) return brief;
  const start = brief.indexOf(`${BRIEF_START}\n`);
  return brief.slice(start === -1 || start > foot ? 0 : start + BRIEF_START.length + 1, foot).replace(/\s*$/, "");
};

// Name only the selected runtime; an unresolved preview still records reports without inventing a send command.
const sendReport = (leadPane: string, runtime: DoriConfig["runtime"]): string | undefined => {
  if (!leadPane || !runtime) return undefined;
  const lead = quoteForPane(leadPane);
  return runtime === "herdr" ? `herdr pane run ${lead} "$line"` : `hc send ${lead} -- "$line"`;
};

export const footer = (
  lane: Lane,
  leadPane: string,
  identities: DoriConfig["repoIdentities"] = {},
  runtime?: DoriConfig["runtime"],
): string => {
  const forward = sendReport(leadPane, runtime);
  return [
    "",
    FOOTER_START,
    FOOTER_HEADING,
    `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
    ...(lane.group
      ? [
          `- Group: ${lane.group}. Your session may be closed and replaced by a successor when your context fills (dori relay): when the lead asks for a handoff, stop new work, write it, and print HANDOFF-WRITTEN.`,
        ]
      : []),
    `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
    "- Persist each milestone, blocker, question, halt and completion with the report command below. It appends reports.jsonl and prints the human [REPORT] line.",
    "- Before forwarding, verify that the lead pane runs a live agent, its input is empty, and no approval or question prompt is open (references/sessions.md). A shell, unknown status or unconfirmed check holds forwarding.",
    "- Supply kind (milestone, blocker, question, halted or done) and text (the report with evidence links) as data, such as environment variables. Never interpolate raw report text into shell source or evaluate the printed line. Record with the command below; when it includes forwarding, run that combined call only after the forwarding checks pass:",
    "```sh",
    `line=$(${CLI} report ${lane.key} --kind "$kind" --text "$text") && printf '%s\\n' "$line"${forward ? ` && ${forward}` : ""}`,
    "```",
    ...(forward
      ? [
          "- Confirm forwarding from the agent's status transition or session record; an exit code or echoed input alone is unconfirmed. Never resend just because no reply is visible.",
        ]
      : [
          "- The lead pane or runtime is unavailable, so the command above only records and prints the report. Keep that line and resolve the missing destination with the lead before forwarding.",
        ]),
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
    `- When done: ${CLI} claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
    FOOTER_END,
    "",
  ].join("\n");
};

export const quoteForPane = (arg: string): string =>
  /^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

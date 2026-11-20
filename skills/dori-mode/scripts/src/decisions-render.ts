import { existsSync } from "node:fs";

import type { Decisions } from "./decisions.ts";
import { type Decision, settled } from "./decisions-record.ts";
import { shellQuote } from "./launch-footer.ts";

const ageHours = (decision: Decision, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(decision.askedAt)) / 3_600_000));

/**
 * One line per open decision for pasting into a status message, with who may settle it (`kind=owner` waits for the
 * owner; `kind=routine` the lead may also choose) and the recommended option marked.
 */
export const decisionText = (decision: Decision, now: number): string => {
  const options = decision.options
    .map((text, i) => ` | ${i + 1}) ${text}${decision.recommend === i + 1 ? " (recommended)" : ""}`)
    .join("");
  const head = `${decision.id} ${ageHours(decision, now)}h lane=${decision.lane ?? "-"} kind=${decision.kind}`;
  return `${head} ${decision.question}${options}`;
};

/** Boot's view of the ledger. No ledger, no lines: a lead that never asked anything sees the boot it always saw. */
export const decisionBootLines = (decisions: Decisions, now: number): { lines: string[]; failed: boolean } => {
  if (!existsSync(decisions.path)) return { lines: [], failed: false };
  try {
    const read = decisions.read();
    const open = read.items.filter((d) => settled(d) === undefined);
    return {
      lines: [
        `DECISIONS open=${open.length}`,
        ...open.map(
          (d) =>
            `DECIDE ${d.id} age=${ageHours(d, now)}h lane=${d.lane ?? "-"} thread=${d.thread ?? "-"} ${JSON.stringify(d.question)}`,
        ),
        ...read.problems.map((problem) => `DECISIONS damaged ${problem}`),
        ...read.warnings.map((warning) => `DECISIONS warning ${warning}`),
      ],
      failed: read.problems.length > 0,
    };
  } catch {
    return { lines: [`DECISIONS unreadable ${shellQuote(decisions.path)}`], failed: true };
  }
};

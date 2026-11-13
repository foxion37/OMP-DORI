import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";

/**
 * The one label dori shows for a lane: where the owner's conversation came from, then the task name the lead passed
 * (`DICO : OMP 이름 설정` for a Discord thread, `TLGR : ...` for Telegram). A lane opened outside a thread has no
 * ticker and shows its title alone.
 */
const TICKER: Readonly<Record<string, string>> = { discord: "DICO", telegram: "TLGR" };

export const laneLabel = (lane: Pick<Lane, "title" | "thread">): string => {
  const ticker = TICKER[lane.thread.slice(0, lane.thread.indexOf(":"))];
  return ticker ? `${ticker} : ${lane.title}` : lane.title;
};

/** The label a lane already carries, or the one its title and thread give it (records written before labels existed). */
export const laneLabelOf = (lane: Lane): string => lane.label ?? laneLabel(lane);

export type LabelTargets = {
  readonly pane?: string | undefined;
  /** The tab dori created for this lane alone; a shared tab keeps its label. */
  readonly tab?: string | undefined;
  /** The workspace dori created for this lane; a workspace dori did not create keeps its label. */
  readonly workspace?: string | undefined;
};

const rename = async (deps: FlowDeps, what: "pane" | "tab" | "workspace", id: string, label: string): Promise<string | undefined> => {
  const r = await deps.run(["herdr", what, "rename", id, label]);
  return r.code === 0 ? undefined : `LABEL_FAILED ${what} ${id}: ${(r.err || r.out).trim().slice(0, 160)}`;
};

/**
 * Applies the lane label to what dori named for it: the pane always, plus the tab and workspace it created for this
 * lane alone. The label is cosmetic, so a failed rename comes back as a line for the caller to print, never a throw.
 */
export const applyLaneLabel = async (deps: FlowDeps, targets: LabelTargets, label: string): Promise<string[]> => {
  const out: string[] = [];
  for (const [what, id] of [["tab", targets.tab], ["workspace", targets.workspace]] as const) {
    if (!id) continue;
    const failure = await rename(deps, what, id, label);
    if (failure) out.push(failure);
  }
  if (targets.pane) {
    const failure = await rename(deps, "pane", targets.pane, label);
    if (failure) out.push(failure);
  }
  return out;
};

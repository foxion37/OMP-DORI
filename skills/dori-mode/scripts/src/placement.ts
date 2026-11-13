import type { FlowDeps } from "./done-flow.ts";
import { LaunchError } from "./launch.ts";
import { listPanes } from "./panes.ts";
import { type Lane, LANE_KEY } from "./registry.ts";

export const GROUP_NAME = LANE_KEY;
export type Direction = "right" | "down";

export type PlacementPlan =
  | { readonly kind: "tab" }
  | { readonly kind: "workspace" }
  | { readonly kind: "split"; readonly from: Lane; readonly direction: Direction };

/**
 * Where a new lane goes. No group: its own tab in `laneWorkspace` (the old behavior). A group with an open lane:
 * split that group's most recently opened lane pane, alternating right/down. A group with no open lane: a workspace.
 */
export const planPlacement = (open: readonly Lane[], group: string | undefined): PlacementPlan => {
  if (!group) return { kind: "tab" };
  const mates = open.filter((l) => l.group === group && l.pane);
  if (!mates.length) return { kind: "workspace" };
  const from = mates.reduce((best, l) => (Date.parse(l.openedAt) >= Date.parse(best.openedAt) ? l : best));
  return { kind: "split", from, direction: mates.length % 2 === 1 ? "right" : "down" };
};

export type Placed = Pick<Lane, "pane" | "tab" | "workspace" | "placement" | "workspaceCreated"> & { readonly pane: string };

type PaneInfo = { pane_id: string; tab_id?: string; workspace_id?: string };

const parse = <T>(what: string, out: string, pick: (json: { result: Record<string, any> }) => T | undefined): T => {
  try {
    const v = pick(JSON.parse(out) as { result: Record<string, any> });
    if (v !== undefined) return v;
  } catch {}
  throw new LaunchError(`herdr ${what} returned no pane: ${out.slice(0, 160)}`);
};

export const splitPane = async (deps: FlowDeps, from: string, direction: Direction, cwd: string): Promise<PaneInfo> => {
  const r = await deps.run(["herdr", "pane", "split", from, "--direction", direction, "--cwd", cwd, "--no-focus"]);
  if (r.code !== 0) throw new LaunchError(`herdr pane split failed: ${r.err || r.out}`);
  return parse("pane split", r.out, (j) => (j.result.pane?.pane_id ? (j.result.pane as PaneInfo) : undefined));
};

export const placeLane = async (deps: FlowDeps, input: { key: string; label: string; group?: string | undefined; cwd: string }): Promise<Placed> => {
  const plan = planPlacement(await deps.registry.open(), input.group);
  if (plan.kind === "split") {
    const workspace = plan.from.workspace ?? (await listPanes(deps.run)).find((p) => p.pane_id === plan.from.pane)?.workspace_id;
    const pane = await splitPane(deps, plan.from.pane ?? "", plan.direction, input.cwd);
    const ws = workspace ?? pane.workspace_id;
    return { pane: pane.pane_id, ...(pane.tab_id ? { tab: pane.tab_id } : {}), ...(ws ? { workspace: ws } : {}), placement: "split" };
  }
  if (plan.kind === "workspace") {
    const r = await deps.run(["herdr", "workspace", "create", "--cwd", input.cwd, "--label", input.label, "--no-focus"]);
    if (r.code !== 0) throw new LaunchError(`herdr workspace create failed: ${r.err || r.out}`);
    const made = parse("workspace create", r.out, (j) => (j.result.root_pane?.pane_id ? { root: j.result.root_pane as PaneInfo, ws: j.result.workspace?.workspace_id as string | undefined } : undefined));
    const ws = made.ws ?? made.root.workspace_id;
    return { pane: made.root.pane_id, ...(made.root.tab_id ? { tab: made.root.tab_id } : {}), ...(ws ? { workspace: ws } : {}), placement: "workspace", workspaceCreated: true };
  }
  const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", input.cwd, "--label", input.label, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
  const made = parse("tab create", created.out, (j) => (j.result.root_pane?.pane_id ? { root: j.result.root_pane as PaneInfo, tab: j.result.tab_id as string | undefined } : undefined));
  const tab = made.tab ?? made.root.tab_id;
  const ws = made.root.workspace_id;
  return { pane: made.root.pane_id, ...(tab ? { tab } : {}), ...(ws ? { workspace: ws } : {}), placement: "tab" };
};

const protectedPane = (deps: FlowDeps, pane: string): boolean => pane === deps.config.leadPane || deps.config.ignorePanes.includes(pane);

/**
 * Closes what dori opened for a lane. A dori-created workspace is closed when no other open lane uses it; a lane placed
 * as a tab closes its tab; anything else closes its pane. A lane recorded before placement existed keeps the old rule:
 * its tab if it has one, else its pane. Never a workspace dori did not create, never the lead or an ignored pane.
 */
export const closePlacement = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const out: string[] = [];
  if (lane.workspace) {
    const all = await deps.registry.list();
    const sameWs = all.filter((l) => l.workspace === lane.workspace && l.key !== lane.key);
    const stillOpen = sameWs.some((l) => !l.closedAt);
    const created = lane.workspaceCreated || sameWs.some((l) => l.workspaceCreated);
    if (created && !stillOpen) {
      const r = await deps.run(["herdr", "workspace", "close", lane.workspace]);
      if (r.code === 0) return [`workspace ${lane.workspace} closed`];
      out.push(`workspace ${lane.workspace} not closed`);
    }
  }
  if (lane.tab && lane.placement !== "split" && lane.placement !== "workspace") {
    out.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  } else if (lane.pane) {
    if (protectedPane(deps, lane.pane)) out.push(`pane ${lane.pane} kept (protected)`);
    else out.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  }
  return out;
};

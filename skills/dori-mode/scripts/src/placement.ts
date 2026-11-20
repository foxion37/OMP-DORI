import type { CloseScope, CreateSpec, SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LANE_KEY, type Lane, sessionOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";

/** A group name is a lane key shape: lowercase, no spaces, and it labels the workspace a group opens. */
export const GROUP_NAME = LANE_KEY;

export type PlacementPlan =
  { readonly kind: "tab" } | { readonly kind: "workspace" } | { readonly kind: "split"; readonly near: SessionRef };

/**
 * Where a new lane goes. No group: its own tab in `laneWorkspace` (the old behavior). A group with an open lane:
 * a split below that group's most recently opened lane. A group with no open lane: a workspace of its own.
 */
export const planPlacement = (open: readonly Lane[], group: string | undefined): PlacementPlan => {
  if (!group) return { kind: "tab" };
  const mates = open.flatMap((lane) => {
    const ref = sessionOf(lane);
    return lane.group === group && ref !== undefined ? [{ lane, ref }] : [];
  });
  const newest = mates.reduce<{ lane: Lane; ref: SessionRef } | undefined>(
    (best, mate) =>
      best === undefined || Date.parse(mate.lane.openedAt) >= Date.parse(best.lane.openedAt) ? mate : best,
    undefined,
  );
  return newest === undefined ? { kind: "workspace" } : { kind: "split", near: newest.ref };
};

export type PlaceInput = {
  /** What the runtime names the session it creates: the lane label once it exists, else the lane key. */
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

/**
 * The lane record fields a placement sets: how the session was placed, the workspace it sits in, and whether dori made
 * that workspace (the only ones it closes).
 */
export const placementFields = (
  container: "workspace-root" | "tab" | "split-below",
  ref: SessionRef,
): Pick<Lane, "placement" | "workspace" | "workspaceCreated"> => ({
  placement: container === "workspace-root" ? "workspace" : container === "split-below" ? "split" : "tab",
  ...(ref.group === undefined ? {} : { workspace: ref.group }),
  ...(container === "workspace-root" ? { workspaceCreated: true } : {}),
});

/**
 * The create spec for a new lane: `workspace-root` for a group's first lane, `split-below` that group's newest lane,
 * else a tab in `laneWorkspace`. hc has neither workspaces nor splits, so every plan there is one labelled terminal and
 * the group is that label.
 */
export const placementSpec = async (
  deps: FlowDeps,
  group: string | undefined,
  base: Omit<CreateSpec, "container">,
): Promise<CreateSpec> => {
  const plan =
    runtimesOf(deps).default.kind === "hc"
      ? ({ kind: "tab" } as const)
      : planPlacement(await deps.registry.open(), group);
  if (plan.kind === "split") return { ...base, container: "split-below", near: plan.near };
  if (plan.kind === "workspace") return { ...base, container: "workspace-root" };
  const workspace = group ?? (deps.config.laneWorkspace || undefined);
  return { ...base, container: "tab", ...(workspace === undefined ? {} : { group: workspace }) };
};

/** A fresh pane next to `near`, for a lane that takes over another's work (relay). */
export const splitFrom = async (deps: FlowDeps, near: SessionRef, input: PlaceInput): Promise<SessionRef> =>
  runtimesOf(deps)
    .for(near)
    .create({ name: input.name, cwd: input.cwd, env: input.env, role: "lane", container: "split-below", near });

/** The group (a herdr workspace, an hc label) an existing session sits in, as its own runtime lists it. */
export const groupOf = async (deps: FlowDeps, ref: SessionRef): Promise<string | undefined> =>
  (await runtimesOf(deps).for(ref).list()).find((s) => s.ref.id === ref.id)?.ref.group;

/** herdr owns workspaces; the runtime closes sessions, so closing one is the raw call, herdr only. */
const closeWorkspace = async (deps: FlowDeps, ref: SessionRef, workspace: string): Promise<string> => {
  if (ref.runtime !== "herdr") return `workspace ${workspace} not closed (${ref.runtime} has no workspaces)`;
  const r = await deps.run(["herdr", "workspace", "close", workspace]);
  return r.code === 0 ? `workspace ${workspace} closed` : `workspace ${workspace} not closed`;
};

/**
 * Closes what dori opened for a lane. A workspace dori created is closed when no other open lane uses it; a lane placed
 * in a tab closes the tab, a split its pane. A lane recorded before placement existed keeps the old rule: its tab if it
 * has one, else its pane. Never a workspace dori did not create, never the lead or an ignored session.
 */
export const closePlacement = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const ref = sessionOf(lane);
  if (ref === undefined) return [];
  const out: string[] = [];
  if (lane.workspace !== undefined) {
    const others = (await deps.registry.list()).filter((l) => l.workspace === lane.workspace && l.key !== lane.key);
    const created = lane.workspaceCreated === true || others.some((l) => l.workspaceCreated === true);
    if (created && !others.some((l) => l.closedAt === undefined)) {
      const line = await closeWorkspace(deps, ref, lane.workspace);
      if (line.endsWith(" closed") && !line.endsWith(" not closed")) return [line];
      out.push(line);
    }
  }
  if (ref.id === deps.config.leadPane || deps.config.ignorePanes.includes(ref.id))
    return [...out, `pane ${ref.id} kept (protected)`];
  const scope: CloseScope =
    lane.placement === "split" || lane.placement === "workspace" || ref.container === undefined
      ? "session"
      : "container";
  const what = scope === "container" ? `tab ${ref.container}` : `pane ${ref.id}`;
  try {
    await runtimesOf(deps).for(ref).close(ref, scope);
    out.push(`${what} closed`);
  } catch {
    out.push(`${what} not closed`);
  }
  return out;
};

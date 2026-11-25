import { randomUUID } from "node:crypto";
import { headlessArgv } from "../../../../src/runtime/headless.ts";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { configPath } from "./config.ts";
import { renderTemplate } from "./launch-template.ts";
import { type LaunchInput, runtimeForLaunch, validateLaunch } from "./launch-input.ts";
import type { FlowDeps } from "./done-flow.ts";
import { parseOwnershipRef, withDeliveryLock, withLaunchLock, withTerminalAdoptionLock } from "./delivery-lock.ts";
import { runContext } from "./lane-run.ts";
import { requirePolicyLaneCommand } from "./lane-policy-launch.ts";
import { policyBinding, prepareLanePolicy, writeLanePolicy } from "./lane-policy-store.ts";
import { BRIEF_START, laneFooterFor, originalBrief } from "./launch-footer.ts";
import { deliverModelBrief, modelLaunchCommand, modelLaunchProblem, unavailableLaunchModel } from "./launch-model.ts";
import { selectionFor } from "./launch-selection.ts";
import { laneStartCommand, openLaneSession, type OpenedLane, startLaunchRun } from "./launch-session.ts";
import { type Lane, sameLaneGeneration, sessionFields, sessionOf } from "./registry.ts";
import { type ChosenRuntimes, iso, runtimesOf } from "./run.ts";
import { Reports } from "./reports.ts";
import { Lessons, renderLessons } from "./lessons.ts";
import { laneLaunchEnv, TokenFileError } from "./slack-token.ts";
import { lastLines, observeLaunch } from "./launch-finished.ts";
import { startHeadless } from "./launch-headless.ts";

export class LaunchError extends Error {}

export const adoptLane = async (
  deps: FlowDeps,
  input: LaunchInput & { readonly pane: string },
  locked = false,
): Promise<Lane> => {
  if (input.requestId !== undefined) throw new LaunchError("adopt cannot attach a request to a running process");
  await validateLaunch(deps, input, LaunchError);
  if (!locked) {
    const held = await withLaunchLock(deps, input.key, () => adoptLane(deps, input, true));
    if (!held.ok) throw new LaunchError(`lane ${input.key} held: ${held.holder}`);
    return held.value;
  }
  const base: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread?.trim() ? input.thread : "none",
    brief: input.brief,
    done: input.done,
    cwd: input.cwd ?? deps.config.defaultCwd,
    openedAt: iso(deps.clock),
  };
  // `tern:42` or a bare Tern block id; a headless lane is launched.
  const ref = parseOwnershipRef(input.pane);
  if (!ref) throw new LaunchError(`--pane must be a Tern block (tern:<id> or <id>), got ${input.pane}`);
  if (ref.runtime === "headless") throw new LaunchError("headless lanes must be launched, not adopted");
  const lane = { ...base, ...sessionFields(ref) };
  const registered = await withTerminalAdoptionLock(deps, ref, () => deps.registry.create(lane));
  if (!registered.ok)
    throw new LaunchError(`terminal adoption held for lane ${input.key}; retry after terminal lifecycle work`);
  if (!registered.value) throw new LaunchError(`lane ${input.key} is already registered`);
  return lane;
};

export const prepareLaunch = async (deps: FlowDeps, input: LaunchInput, queuedBrief?: string) => {
  await validateLaunch(deps, input, LaunchError);
  const { agentCommand, requireModelReadback } = deps.config;
  requirePolicyLaneCommand(agentCommand, deps.config.lanePolicy, LaunchError);
  const model = input.model ?? deps.config.defaultModel;
  // Preparing a brief (including --dry-run) needs the execution mode, not an installed terminal adapter.
  const mode = input.runtime ?? deps.config.laneRuntime ?? runtimesOf(deps).choice?.kind;
  const problem = modelLaunchProblem(agentCommand, model, mode === "headless" || requireModelReadback);
  if (problem) throw new LaunchError(problem);
  // The broker verifies the native model before kickoff; only terminal templates can launch without readback.
  const modelReadback = mode === "headless" ? undefined : unavailableLaunchModel(agentCommand, model, iso(deps.clock));
  const cwd = input.cwd ?? deps.config.defaultCwd;
  let briefText: string;
  if (queuedBrief !== undefined) {
    briefText = queuedBrief;
  } else if (input.template) {
    briefText = renderTemplate(input.template, input.variables ?? {}, deps.env?.["CATALY_CONFIG"] ?? configPath());
  } else {
    const briefFile = Bun.file(input.brief);
    if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
    briefText = originalBrief(await briefFile.text());
  }
  const draft: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread?.trim() ? input.thread : "none",
    ...(input.requestId === undefined ? {} : { requestId: input.requestId, runId: randomUUID() }),
    brief: input.brief,
    done: input.done,
    cwd,
    model,
    ...(modelReadback ? { modelReadback } : {}),
    launchSelection: selectionFor(deps.config),
    openedAt: iso(deps.clock),
    reportProtocol: "jsonl-v1",
    budget: {
      ...deps.config.supervision.defaults,
      ...deps.config.supervision.lanes?.[input.key],
      // An undefined field is absent, so it keeps the configured ceiling; only null turns one off.
      ...Object.fromEntries(Object.entries(input.budget ?? {}).filter(([, value]) => value !== undefined)),
    },
    activityPaths: input.activityPaths ?? [],
  };
  // A damaged journal line is a warning: it must not keep a lane from starting or hide the lessons around it.
  const { lessons, problems, omitted } = new Lessons(deps.config.stateDir).forRepo(cwd);
  // A lesson the cap kept out is named too: a brief that silently lacks a standing rule is the bug this catches.
  const warnings = [
    ...(modelReadback
      ? [`MODEL_READBACK_WARNING ${modelReadback.reason}; enable requireModelReadback to refuse unverified launches`]
      : []),
    ...problems.map((problem) => `LESSON_WARNING ${problem}`),
    ...omitted.map(
      (lesson) => `LESSON_OMITTED ${lesson.id} (${lesson.scope === "global" ? "global" : lesson.cwd}) ${lesson.rule}`,
    ),
  ];
  const laneFooter = await laneFooterFor(deps, draft);
  const preamble = `${renderLessons(lessons)}${BRIEF_START}\n${briefText}\n${laneFooter}`;
  return { lane: draft, briefText, preamble, warnings } as const;
};

export const launchLane = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly startup: string; readonly warnings: string[] }> => {
  await validateLaunch(deps, input, LaunchError);
  const held = await withLaunchLock(deps, input.key, async () => {
    const opened = await openLaunch(deps, input);
    return { ...(await opened.start()), warnings: opened.warnings };
  });
  if (!held.ok) throw new LaunchError(`lane ${input.key} held: ${held.holder}`);
  return held.value;
};

/** Caller holds the per-key launch lock; capacity admission only needs to span this phase. */
export const openLaunch = async (deps: FlowDeps, input: LaunchInput, queuedBrief?: string) => {
  const runtime = runtimeForLaunch(deps, input);
  const { lane: draft, preamble, warnings } = await prepareLaunch(deps, input, queuedBrief);
  runContext(new Reports(deps.config.stateDir), draft, draft.runId);
  const rts = runtimesOf(deps);
  const group = runtime === "headless" ? undefined : deps.config.laneWorkspace || undefined;
  const policy = prepareLanePolicy(deps.config.stateDir, input.key, deps.config.lanePolicy);
  let argv: readonly string[] | undefined;
  if (runtime === "headless") {
    try {
      argv = headlessArgv(deps.config.agentCommand, input.model ?? deps.config.defaultModel);
    } catch (error) {
      throw new LaunchError(error instanceof Error ? error.message : String(error));
    }
  }
  let env: Record<string, string>;
  try {
    const callerEnv = runtime === "headless" ? (deps.env ?? process.env) : process.env;
    env = laneLaunchEnv(callerEnv, callerEnv["CATALY_CONFIG"] ?? configPath(), deps.config);
    if (runtime !== "headless" && draft.requestId !== undefined) env["CATALY_LANE_RUN"] = "";
  } catch (e) {
    throw e instanceof TokenFileError ? new LaunchError(`token file refused: ${e.message}`) : e;
  }
  env["CATALY_LANE_POLICY"] = policy ? policyBinding(policy) : "";
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const spec = { name: input.key, role: "lane", container: "tab", cwd, env } as const;
  const opened = await openLaneSession(deps.registry, rts, group === undefined ? spec : { ...spec, group }, draft, {
    preamble,
    runtime,
    generated: queuedBrief !== undefined || Boolean(input.template),
  });
  if (opened.kind === "failed") {
    const why = opened.error instanceof Error ? opened.error.message : String(opened.error);
    throw new LaunchError(`${opened.what}: ${why}`);
  }
  if (opened.kind === "taken") throw new LaunchError(`lane ${input.key} is already registered`);
  if (policy) writeLanePolicy(policy, opened.lane);
  return {
    warnings,
    start: () =>
      argv === undefined
        ? startLane(deps, input, { opened, rts })
        : startHeadless(deps, input, { opened, rts, argv, env }),
  };
};

const startLane = async (
  deps: FlowDeps,
  input: LaunchInput,
  { opened, rts }: { readonly opened: Extract<OpenedLane, { kind: "opened" }>; readonly rts: ChosenRuntimes },
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  const { lane, ref } = opened;
  const pane = ref.id;
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  const command = deps.config.agentCommand;
  const start = async (): Promise<{ readonly launchedAt: number } | { readonly startup: string }> => {
    const provenance = lane.requestId === undefined ? undefined : await startLaunchRun(deps, lane);
    if (provenance === null) return { startup: `STARTUP_ERROR ${input.key} ${pane}: lane changed before start` };
    // Launch starts the activity journal; it is not a lane report and is never posted to the thread.
    new Reports(deps.config.stateDir).append({
      type: "activity",
      key: lane.key,
      at: iso(deps.clock),
      state: "running",
      text: `lane launched in ${pane}`,
      ...(provenance ? { provenance } : {}),
    });
    // The session can be written while start is still returning; its goal must belong to this invocation.
    const launchedAt = deps.clock.now();
    try {
      await rts.terminal(ref.runtime).start(ref, laneStartCommand(lane, modelLaunchCommand(command, model, prompt)));
      return { launchedAt };
    } catch (error) {
      return { startup: `STARTUP_ERROR ${input.key} ${pane}: start failed: ${lastLines(String(error))}` };
    }
  };
  // Serialize sourced admission and submission, not the potentially long startup observation.
  const submitted =
    lane.requestId === undefined
      ? { ok: true as const, value: await start() }
      : await withDeliveryLock(deps, lane.key, start);
  if (!submitted.ok)
    return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: delivery lock held (${submitted.holder})` };
  if ("startup" in submitted.value) return { lane, startup: submitted.value.startup };
  const { launchedAt } = submitted.value;
  const deliverBrief =
    !lane.modelReadback && mayRunOmpArgv(command)
      ? async (): Promise<string | null> => {
          const delivery = await withDeliveryLock(deps, lane.key, async () => {
            const current = await deps.registry.read(lane.key);
            const live = current && sessionOf(current);
            if (
              !current ||
              current.nativeCloseIntent ||
              !sameLaneGeneration(lane, current) ||
              current.requestId !== lane.requestId ||
              current.runId !== lane.runId ||
              live?.runtime !== ref.runtime ||
              live.id !== ref.id
            )
              return "lane changed before verified delivery; brief not sent";
            return deliverModelBrief(deps, ref, model, prompt, launchedAt);
          });
          return delivery.ok ? delivery.value : `delivery lock held (${delivery.holder}); brief not sent`;
        }
      : undefined;
  return observeLaunch(deps, input, { lane, ref, rts, launchedAt, ...(deliverBrief ? { deliverBrief } : {}) });
};

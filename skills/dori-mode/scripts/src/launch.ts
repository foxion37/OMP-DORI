import { configPath, fill, isOmpCommand } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { laneGoalActive } from "./goal-record.ts";
import { BRIEF_START, footer, originalBrief, quoteForPane } from "./launch-footer.ts";
import { applyLaneLabel, laneLabel } from "./labels.ts";
import { type PlaceInput, type Placed, GROUP_NAME, placeLane } from "./placement.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { LANE_KEY, type Lane, RESERVED_LANE_KEY } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { Reports } from "./reports.ts";
import { doneSyntaxErrors } from "./signals.ts";
import type { BudgetLimits } from "./supervision-observe.ts";
import { Lessons, renderLessons } from "./lessons.ts";
import { laneLaunchEnv, TokenFileError } from "./slack-token.ts";
import { startupFailure } from "./startup-screen.ts";
import { FIRST_CHECK_MS, launchFinished, launchScreen, launchStatus, lastLines } from "./launch-finished.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  /** Work stream: a lane of the same group is split below, a new group opens its own workspace. */
  readonly group?: string;
};

export class LaunchError extends Error {}

// After the first check (launch-finished's FIRST_CHECK_MS) the screen and status are re-read every 10 s.
const RECHECK_MS = 10_000;
const unreported = (s: string | undefined): boolean => s === undefined || s === "unknown";
// OMP goals come from its trusted current-session record, never quoted screen text. Custom agents may use their
// footer marker or omo goal record. An empty marker opts out of the goal check, not the ready-status check.
const goalShown = (screen: string, marker: string): boolean =>
  screen
    .split("\n")
    .filter((s) => s.trim())
    .slice(-3)
    .join("\n")
    .includes(marker);

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (input.key === RESERVED_LANE_KEY)
    throw new LaunchError(`lane key "${RESERVED_LANE_KEY}" is reserved for the lead`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  if (input.group !== undefined && !GROUP_NAME.test(input.group))
    throw new LaunchError(`group must match ${GROUP_NAME}`);
  for (const [name, value] of Object.entries(input.budget ?? {})) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new LaunchError(`invalid ${name} ceiling`);
  }
};

/** The statuses that mean the agent is up and taking turns: herdr reports a finished first turn as "done". */
export const ready = (status: string | undefined): boolean =>
  status === "idle" || status === "working" || status === "done";

/**
 * One startup check for a session dori started outside a launch (a relay's successor): the screen for a known failure,
 * then the runtime's status. STARTUP_DONE when the session is gone and the lane already finished; a relay keeps its
 * old session unless this returns STARTUP_OK.
 */
export const checkStartup = async (deps: FlowDeps, key: string, ref: SessionRef): Promise<string> => {
  const rts = runtimesOf(deps);
  await deps.clock.sleep(FIRST_CHECK_MS);
  const screen = await launchScreen(deps, rts, ref, key);
  if (screen === null) return `STARTUP_DONE ${key}`;
  const omp = isOmpCommand(deps.config.agentCommand);
  const bad = startupFailure(screen, omp);
  if (bad) return `STARTUP_ERROR ${key} ${ref.id}: ${bad}`;
  const { status, error } = await launchStatus(rts, ref, omp);
  if (status === "gone" && (await launchFinished(deps, key))) return `STARTUP_DONE ${key}`;
  if (ready(status)) return `STARTUP_OK ${key} ${ref.id}`;
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return `STARTUP_UNCONFIRMED ${key} ${ref.id}: ${why}; last lines: ${lastLines(screen)}`;
};

export const prepareLaunch = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly preamble: string; readonly warnings: string[] }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread ?? "none",
    label: laneLabel({ title: input.title, thread: input.thread ?? "none" }),
    brief: input.brief,
    done: input.done,
    cwd,
    model,
    openedAt: iso(deps.clock),
    reportProtocol: "jsonl-v1",
    budget: {
      ...deps.config.supervision.defaults,
      ...deps.config.supervision.lanes?.[input.key],
      // An undefined field is absent, so it keeps the configured ceiling; only null turns one off.
      ...Object.fromEntries(Object.entries(input.budget ?? {}).filter(([, value]) => value !== undefined)),
    },
    activityPaths: input.activityPaths ?? [],
    ...(input.group === undefined ? {} : { group: input.group }),
  };
  // A damaged journal line is a warning: it must not keep a lane from starting or hide the lessons around it.
  const { lessons, problems, omitted } = new Lessons(deps.config.stateDir).forRepo(cwd);
  return {
    lane: draft,
    // A lesson the cap kept out is named too: a brief that silently lacks a standing rule is the bug this catches.
    warnings: [
      ...problems.map((problem) => `LESSON_WARNING ${problem}`),
      ...omitted.map(
        (lesson) => `LESSON_OMITTED ${lesson.id} (${lesson.scope === "global" ? "global" : lesson.cwd}) ${lesson.rule}`,
      ),
    ],
    preamble: `${renderLessons(lessons)}${BRIEF_START}\n${originalBrief(await briefFile.text())}\n${footer(draft, deps.config.leadPane, deps.config.repoIdentities, runtimesOf(deps).choice?.kind)}`,
  };
};

export const launchLane = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly startup: string; readonly warnings: string[] }> => {
  const prepared = await prepareLaunch(deps, input);
  return { ...(await startLane(deps, input, prepared.lane, prepared.preamble)), warnings: prepared.warnings };
};

const startLane = async (
  deps: FlowDeps,
  input: LaunchInput,
  draft: Lane,
  preamble: string,
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  await Bun.write(input.brief, preamble);
  const rts = runtimesOf(deps);
  const label = laneLabel(draft);
  let env: Record<string, string>;
  try {
    env = { ...laneLaunchEnv(process.env, configPath()), DORI_LANE_LABEL: label };
  } catch (e) {
    throw e instanceof TokenFileError ? new LaunchError(`token file refused: ${e.message}`) : e;
  }
  let placed: Placed;
  try {
    const place: PlaceInput = {
      name: label,
      cwd,
      env,
      ...(input.group === undefined ? {} : { group: input.group }),
    };
    placed = await placeLane(deps, place);
  } catch (e) {
    throw new LaunchError(`session create failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { ref, ...seat } = placed;
  const pane = ref.id;
  // Registered before the agent starts: dori report refuses an unknown key, so a fast lane's first report would be lost.
  const lane: Lane = { ...draft, ...seat };
  await deps.registry.write(lane);
  // A tab or workspace dori created already carries the label; a split pane only needs its own rename.
  if (seat.placement === "split" && ref.runtime === "herdr")
    for (const line of await applyLaneLabel(deps, { runtime: ref.runtime, pane }, label)) console.error(line);
  // The launch is an activity record, not a report: it starts the journal (so the screen is watched for a stall) but is
  // never posted to the thread as if the agent had reported.
  new Reports(deps.config.stateDir).append({
    type: "activity",
    key: lane.key,
    at: iso(deps.clock),
    state: "running",
    text: `lane launched in ${pane}`,
  });
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  // The session can be written while start is still returning; its goal must belong to this invocation.
  const launchedAt = deps.clock.now();
  try {
    await rts.for(ref).start(ref, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" "));
  } catch (e) {
    return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: start failed: ${lastLines(String(e))}` };
  }
  const started = deps.clock.now();
  await deps.clock.sleep(FIRST_CHECK_MS);
  const screen = await launchScreen(deps, rts, ref, input.key);
  if (screen === null) return { lane, startup: `STARTUP_DONE ${input.key}` };
  const ompAgent = isOmpCommand(deps.config.agentCommand);
  const bad = startupFailure(screen, ompAgent);
  if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${bad}` };
  const { status, error } = await launchStatus(rts, ref, ompAgent);
  if (status === "gone" && (await launchFinished(deps, input.key)))
    return { lane, startup: `STARTUP_DONE ${input.key}` };
  // No status and no lookup error is an agent still starting (a slow host can take minutes, #202): it is waited for in
  // the goal wait. A lookup error, a `shell` or any other status ends the launch below at once.
  if (ready(status) || (unreported(status) && !error)) {
    const marker = deps.config.goalMarker;
    const omp = ompAgent ? { run: deps.run, rts, stateDir: deps.config.stateDir, ref } : undefined;
    const hasGoal = async (shown: string): Promise<boolean> =>
      (!omp && goalShown(shown, marker)) ||
      (await laneGoalActive(deps.config.sessionsDir, cwd, input.key, launchedAt, omp));
    const rechecks = Math.max(0, Math.ceil((deps.config.startupWaitSeconds * 1000 - FIRST_CHECK_MS) / RECHECK_MS));
    let shown = screen;
    let current = status;
    for (let check = 0; !ready(current) || (marker && !(await hasGoal(shown))); check++) {
      if (check >= rechecks) {
        const waited = Math.round((deps.clock.now() - started) / 1000);
        return {
          lane,
          startup: ready(current)
            ? `STARTUP_NO_GOAL ${input.key} ${pane}: the agent is running but shows no goal after ${waited} s; last lines: ${lastLines(shown)}`
            : `STARTUP_UNCONFIRMED ${input.key} ${pane}: no ready agent status (${current ?? "none"}) after ${waited} s; last lines: ${lastLines(shown)}`,
        };
      }
      await deps.clock.sleep(RECHECK_MS);
      const nextScreen = await launchScreen(deps, rts, ref, input.key);
      if (nextScreen === null) return { lane, startup: `STARTUP_DONE ${input.key}` };
      shown = nextScreen;
      // The goal is only good news while the agent is still running: re-check the status on every re-read.
      const again = await launchStatus(rts, ref, ompAgent);
      current = again.status;
      if (current === "gone" && (await launchFinished(deps, input.key)))
        return { lane, startup: `STARTUP_DONE ${input.key}` };
      if (again.error || !(ready(current) || unreported(current))) {
        const lost = again.error
          ? `status lookup failed: ${again.error}`
          : `agent status became ${again.status ?? "none"}`;
        return {
          lane,
          startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${lost} while waiting for its goal; last lines: ${lastLines(shown)}`,
        };
      }
      // A late failure stops the agent. A working agent's own output may quote these phrases (a file or log it reads),
      // so only a non-working agent with no goal is checked for one, including a still-unreported slow start.
      const failed = current !== "working" && !(await hasGoal(shown)) ? startupFailure(shown, ompAgent) : null;
      if (failed) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${failed}` };
    }
    return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
  }
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

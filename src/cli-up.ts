import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { agentCommand, harnessLaunchEnv, rolePrompt, type Deps } from "./harness.ts";
import { nativeHarnessStatus, nativeInventory, startNativeHarness, withHarnessLock } from "./harness-native.ts";
import { leadResume } from "./harness-native-resume.ts";
import { lockEnv } from "./lock.ts";
import { lockLines } from "./lock-list.ts";
import { refText } from "./refs.ts";
import { Refusal } from "./refusal.ts";
import { groupId } from "./runtime/group.ts";
import { HeadlessRuntime } from "./runtime/headless.ts";
import { openSession, type SessionRef, type TerminalRuntime } from "./runtime/types.ts";
import { RuntimeChoiceError } from "./runtime/select.ts";
import { laneBoard } from "./status-view.ts";
import { knownRefs } from "./target.ts";

function renderPrompt(d: Deps, name: "lead.md" | "duty.md"): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  writeFileSync(out, rolePrompt(d, name));
  return out;
}

/**
 * Opens lead, duty, the duty loop and the hourly loop on the selected runtime and registers all four roles. Headless: the lead resumes the
 * session the last harness stop closed cleanly, unless `fresh`. Tern: the lead is a new session's first block, duty a
 * tab in it, the loops splits below duty.
 */
export async function up(d: Deps, cwd: string, fresh = false): Promise<void> {
  await withHarnessLock(d, async () => {
    if (nativeInventory(d))
      throw new Refusal("a native harness is already registered or held; inspect status and use cataly harness stop");
    if (Object.keys(d.store.roles()).length)
      throw new Refusal(
        "this home already has registered roles. Close their Tern sessions and run cataly harness stop to retire the registrations before up",
      );
    const rt = d.runtimes.default;
    if (rt.kind === "headless") {
      if (!(rt instanceof HeadlessRuntime)) throw new Refusal("native harness runtime is unavailable");
      await startNativeHarness(d, rt, cwd, leadResume(d, rt.stateDir, fresh));
    } else {
      await upTerminal(d, cwd, rt);
    }
  });
}

async function upTerminal(d: Deps, cwd: string, rt: TerminalRuntime): Promise<void> {
  const env = { ...harnessLaunchEnv(d), CATALY_RUNTIME: rt.kind };
  const agent = (name: "lead.md" | "duty.md") =>
    `${agentCommand(d, "cataly")} --append-system-prompt ${shq(renderPrompt(d, name))}`;
  const lead = await openSession(
    rt,
    { name: "cataly", role: "lead", container: "workspace-root", cwd, env, group: groupId(d.store.root) },
    agent("lead.md"),
  );
  d.store.setRole("lead", lead);
  const group = lead.group;
  const inGroup = group === undefined ? {} : { group };
  const duty = await openSession(
    rt,
    { name: "duty", role: "duty", container: "tab", cwd, env, ...inGroup },
    agent("duty.md"),
  );
  d.store.setRole("duty", duty);
  const loop = await openSession(
    rt,
    { name: "duty-loop", role: "duty-loop", container: "split-below", near: duty, cwd, env, ...inGroup },
    `${d.catalyCmd} duty --interval 60`,
  );
  d.store.setRole("duty-loop", loop);
  const hourly = await openSession(
    rt,
    { name: "hourly-loop", role: "hourly-loop", container: "split-below", near: loop, cwd, env, ...inGroup },
    `${d.catalyCmd} loop`,
  );
  d.store.setRole("hourly-loop", hourly);
  console.log(
    `UP runtime=${rt.kind} lead=${refText(lead)} duty=${refText(duty)} loop=${refText(loop)} hourly=${refText(hourly)} home=${d.store.root}`,
  );
}

/** The runtime line first (a runtime that cannot be chosen is shown, not thrown; a bad setting still throws). */
function runtimeLine(d: Deps): string {
  try {
    const c = d.choice();
    return `RUNTIME ${c.kind} (from ${c.source})`;
  } catch (e) {
    if (e instanceof RuntimeChoiceError) return `RUNTIME unset: ${e.message}`;
    throw e;
  }
}

/**
 * The runtime line, the roles and the home path, each on a line of its own and never wrapped: the runtime line can name
 * the config file and the home is a path, either of which may hold spaces, and a path broken at one names no file.
 * Wider than a line, the terminal folds them. The lane board below keeps within WIDTH, and so does the line per lock
 * held or waited for (lock-list.ts) at the end.
 */
export async function status(d: Deps): Promise<void> {
  const roles = d.store.roles();
  const show = (ref: SessionRef | undefined) => (ref ? refText(ref) : "-");
  for (const line of [runtimeLine(d), `lead=${show(roles.lead)} duty=${show(roles.duty)}`, `home=${d.store.root}`])
    console.log(line);
  for (const line of await nativeHarnessStatus(d)) console.log(line);
  for (const line of laneBoard(d.store.lanes(), d.now(), knownRefs(d.store))) console.log(line);
  for (const line of lockLines({ ...lockEnv(d.store.root), now: d.now })) console.log(line);
}

// The managed target is the Cataly home's native headless harness (`harness-native.json`), observed through its
// HeadlessRuntime and started/stopped by the owning release's own `cataly harness up|stop`.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RESUME_SESSION_ENV } from "../harness-native-resume.ts";
import { type HeadlessObservation, HeadlessRuntime } from "../runtime/headless.ts";
import { readPrivate } from "../runtime/headless-record.ts";
import { HEADLESS_ADDRESS, type SessionRef } from "../runtime/types.ts";
import {
  actorEnv,
  DeploymentBusy,
  DeploymentHeld,
  managedOmpCommand,
  processIdentity,
  sameProcess,
} from "./deployment-process.ts";
import { verifyQuiesceCheckpoint } from "./deployment-quiesce.ts";
import type { DeploymentConfig, DeploymentRecord, RuntimeIdentity, ToolchainReceipt } from "./deployment-types.ts";
import { digest } from "./source.ts";
import { procExe } from "./proc.ts";

type Binding = { readonly ref?: SessionRef; readonly sessionId?: string };
type Inventory = { readonly version: 1; readonly stateDir: string; readonly roles: Readonly<Record<string, Binding>> };

// `harness up` proves each of its four roles within the headless start deadline.
const HARNESS_COMMAND_MS = 300_000;
const executableHashes = new Map<string, string>();

/** The owned inventory, bound to this deployment's state directory. Absent means no harness is registered. */
export function readInventory(config: DeploymentConfig): Inventory | undefined {
  const saved = readPrivate<Inventory>(join(config.catalyHome, "harness-native.json"));
  if (!saved) return undefined;
  if (
    saved.version !== 1 ||
    typeof saved.stateDir !== "string" ||
    !isAbsolute(saved.stateDir) ||
    typeof saved.roles !== "object" ||
    saved.roles === null ||
    Array.isArray(saved.roles)
  )
    throw new DeploymentHeld("native harness inventory is invalid");
  if (realpathSync(saved.stateDir) !== realpathSync(config.stateDir))
    throw new DeploymentHeld("native harness state directory differs from the managed deployment");
  return saved;
}

function leadBinding(config: DeploymentConfig): { runtime: HeadlessRuntime; ref: SessionRef; sessionId: string } {
  const inventory = readInventory(config);
  if (!inventory) throw new DeploymentHeld("no native harness is registered for this Cataly home");
  const { ref, sessionId } = inventory.roles["lead"] ?? {};
  if (ref?.runtime !== "headless" || !HEADLESS_ADDRESS.test(ref.id) || typeof sessionId !== "string" || !sessionId)
    throw new DeploymentHeld("native harness has no verified lead binding");
  return { runtime: new HeadlessRuntime(inventory.stateDir), ref, sessionId };
}

/** Observe the lead without capturing a process identity. */
export async function observeLead(config: DeploymentConfig): Promise<HeadlessObservation> {
  const { runtime, ref } = leadBinding(config);
  return runtime.observe(ref);
}

/** Every bound harness role is present under its own reservation. */
export async function assertHarnessRoles(config: DeploymentConfig): Promise<void> {
  const inventory = readInventory(config);
  if (!inventory) throw new DeploymentHeld("no native harness is registered for this Cataly home");
  const runtime = new HeadlessRuntime(inventory.stateDir);
  for (const [role, binding] of Object.entries(inventory.roles)) {
    if (!binding.ref) throw new DeploymentHeld(`native ${role} has no reservation`);
    const seen = await runtime.observe(binding.ref);
    if (seen.harnessRole !== role || seen.status === "gone" || seen.status === "unknown" || seen.status === "error")
      throw new DeploymentHeld(`native ${role} is not running`);
  }
}

/**
 * The lead's headless observation replaces a terminal probe: pid, session, reservation start, cwd and the idle/approval
 * boundary. The process identity and executable hash bind that observation to one incarnation.
 */
export async function captureRuntime(
  config: DeploymentConfig,
  allowWorking = false,
  quiesce?: DeploymentRecord,
): Promise<RuntimeIdentity> {
  const { runtime: rt, ref, sessionId } = leadBinding(config);
  const seen = await rt.observe(ref);
  if (
    seen.harnessRole !== "lead" ||
    seen.role !== "cataly" ||
    seen.sessionId !== sessionId ||
    !seen.sessionFile ||
    seen.pid === undefined ||
    !seen.cwd ||
    !Number.isFinite(Date.parse(seen.startedAt)) ||
    (seen.held && !allowWorking) ||
    (seen.status !== "idle" &&
      seen.status !== "done" &&
      seen.status !== "working" &&
      !(allowWorking && seen.status === "blocked" && seen.held))
  )
    throw new DeploymentHeld("native Cataly identity, idle state or approval boundary did not match");
  const identity = processIdentity(seen.pid);
  if (!identity) throw new DeploymentHeld("native PID identity is unavailable");
  const key = JSON.stringify(identity);
  let executableHash = executableHashes.get(key);
  if (!executableHash) {
    executableHash = digest(readFileSync(procExe(identity.pid)));
    if (!sameProcess(identity)) throw new DeploymentHeld("native executable changed during capture");
    executableHashes.set(key, executableHash);
  }
  const captured: RuntimeIdentity = {
    ...identity,
    ref: ref.id,
    role: "cataly",
    sessionId,
    sessionFile: seen.sessionFile,
    startedAt: seen.startedAt,
    cwd: seen.cwd,
    executableHash,
  };
  const latest = await rt.observe(ref);
  if (
    latest.pid !== seen.pid ||
    latest.sessionId !== seen.sessionId ||
    latest.sessionFile !== seen.sessionFile ||
    latest.startedAt !== seen.startedAt ||
    latest.cwd !== seen.cwd ||
    !sameProcess(identity)
  )
    throw new DeploymentHeld("native identity changed during observation");
  if (!allowWorking && latest.held) throw new DeploymentHeld("native approval became pending during observation");
  const busy = seen.status === "working" || latest.status === "working";
  if (busy && !allowWorking) {
    if (!quiesce) throw new DeploymentBusy("native Cataly is busy; waiting for its idle boundary");
    verifyQuiesceCheckpoint(config, quiesce, captured);
  }
  return { ...captured, busy, approvalPending: latest.held };
}

async function harnessCommand(
  config: DeploymentConfig,
  source: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DeploymentHeld("native harness command interrupted");
  const proc = Bun.spawn([config.bun, join(source, "src/cli.ts"), ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: HARNESS_COMMAND_MS,
    killSignal: "SIGKILL",
    ...(signal ? { signal } : {}),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return;
  const detail = (err.trim() || out.trim() || `exit ${code}`).split("\n").join("; ").slice(0, 500);
  throw new DeploymentHeld(`native harness ${args[0]} held: ${detail}`);
}

/** Stop the whole harness with the releasing source's own idle/approval/inbox gates. */
export async function stopHarness(config: DeploymentConfig, source: string, signal?: AbortSignal): Promise<void> {
  if (!readInventory(config)) return;
  await harnessCommand(config, source, ["stop"], actorEnv(config), config.home, signal);
  if (readInventory(config)) throw new DeploymentHeld("native harness stop did not retire its inventory");
}

/**
 * Start every harness role from `source`, pinned to the prepared native toolchain and update fence. A `resumeSessionId`
 * (the stopped old lead's session) must be resumed by the new lead; `up` refuses rather than start a fresh lead.
 */
export async function startHarness(
  config: DeploymentConfig,
  source: string,
  toolchain: ToolchainReceipt,
  cwd: string,
  resumeSessionId?: string,
  signal?: AbortSignal,
): Promise<void> {
  // A published inventory means an earlier start already owns the harness; health decides whether it is ours.
  if (readInventory(config)) return;
  const env = {
    ...actorEnv(config, toolchain),
    CATALY_AGENT_ARGV: JSON.stringify(managedOmpCommand(toolchain, source)),
    ...(resumeSessionId ? { [RESUME_SESSION_ENV]: resumeSessionId } : {}),
  };
  await harnessCommand(config, source, ["up", "--cwd", cwd], env, cwd, signal);
}

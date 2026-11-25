import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { liveSessions, object, type Request, type Session } from "../../../../src/remote/client.ts";
import { type HeadlessObservation, headlessArgv, HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import { isOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { formatRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { configPath, expandHome } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { resumeFile } from "./lifecycle-session.ts";
import { statusOf } from "./registry.ts";
import { remoteId, RemoteRecords } from "./remote-records.ts";
import { runtimesOf } from "./run.ts";
import { laneLaunchEnv } from "./slack-token.ts";

function executable(deps: FlowDeps): readonly string[] {
  const argv = deps.config.agentCommand;
  const role = argv.indexOf("--cataly-role");
  const model = argv.indexOf("--model");
  if (
    !isOmpArgv(argv) ||
    role < 1 ||
    argv[role + 1] !== "lane" ||
    model !== role + 2 ||
    argv[model + 1] !== "{model}" ||
    argv[model + 2] !== "{prompt}" ||
    model + 3 !== argv.length
  )
    throw new Error("Remote launch needs Cataly's native OMP lane argv; custom startup commands are not run remotely");
  return argv.slice(0, role);
}

async function nativeCli(deps: FlowDeps, argv: readonly string[]) {
  const result = await deps.run([...executable(deps), ...argv], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`OMP ${argv[0]} failed (${result.code})`);
  return result.out;
}

function directory(path: string): string {
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) throw new Error("Use an absolute target-machine directory");
  const real = realpathSync(expanded);
  if (!statSync(real).isDirectory()) throw new Error("Target path is not a directory");
  return real;
}

/** The endpoint the started OMP publishes itself, bound to the supervisor's observed process, session and cwd. */
async function waitForSession(deps: FlowDeps, runtime: HeadlessRuntime, seen: HeadlessObservation): Promise<Session> {
  const { ref } = seen;
  const pane = formatRef(ref);
  const cwd = realpathSync(seen.cwd);
  const end = deps.clock.now() + 20_000;
  let identity = "no live OMP endpoint";
  do {
    const live = (await liveSessions(deps.config.stateDir)).find((row) => row.pane === pane);
    if (live) {
      identity = `session=${live.session === seen.sessionId}, pid=${live.pid === seen.pid}`;
      if (live.session === seen.sessionId && live.pid === seen.pid && realpathSync(live.cwd) === cwd) return live;
    }
    if ((await runtime.observe(ref)).status === "gone") break;
    await deps.clock.sleep(200);
  } while (deps.clock.now() < end);
  throw new Error(`OMP startup unconfirmed in ${pane} (${identity}); inspect it before attempting another launch`);
}

/** A standalone headless session: a launched lane's native reservation and supervisor, with no registry row. */
async function start(
  deps: FlowDeps,
  launch: { readonly cwd: string; readonly name: string; readonly argv: readonly string[] },
  reserved: (ref: SessionRef) => void,
  resume?: { readonly file: string; readonly sessionId: string },
): Promise<{ readonly session: Session; readonly runtime: HeadlessRuntime; readonly ref: SessionRef }> {
  const runtime = runtimesOf(deps).default;
  if (!(runtime instanceof HeadlessRuntime)) throw new Error("Headless supervisor unavailable");
  const callerEnv = deps.env ?? process.env;
  const env = laneLaunchEnv(callerEnv, callerEnv["CATALY_CONFIG"] ?? configPath(), deps.config);
  const ref = await runtime.create({ name: launch.name, cwd: launch.cwd, env, role: "lane" });
  reserved(ref);
  const seen = await runtime.startNative(ref, launch.argv, env, resume);
  if (
    seen.ref.runtime !== ref.runtime ||
    seen.ref.id !== ref.id ||
    seen.role !== "lane" ||
    !seen.sessionId ||
    seen.pid === undefined ||
    (resume !== undefined && seen.sessionId !== resume.sessionId) ||
    realpathSync(seen.cwd) !== launch.cwd
  )
    throw new Error(`OMP startup unconfirmed in ${formatRef(ref)}; inspect it before attempting another launch`);
  return { session: await waitForSession(deps, runtime, seen), runtime, ref };
}

export async function openRemoteSession(deps: FlowDeps, request: Request): Promise<unknown> {
  const id = request.id;
  if (!id || !remoteId.test(id)) throw new Error("Open requires a request ID");
  const records = new RemoteRecords(deps.config.stateDir);
  return await records.exclusive(`open-${id}`, async () => {
    const receipt = records.path("open", id);
    const prior = records.read(receipt);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          request.cwd,
          request.name,
          request.model,
          request.thinking,
          request.worktree,
          request.branch,
          request.base,
          request.text,
        ]),
      )
      .digest("hex");
    if (prior && prior["fingerprint"] !== fingerprint)
      throw new Error("Open request ID was already used with different input");
    if (prior?.["status"] === "opened") {
      const { fingerprint: _fingerprint, ...result } = prior;
      return result;
    }
    if (prior) throw new Error("Previous open is unconfirmed; inspect the target before attempting another launch");
    const cwd = directory(request.cwd ?? deps.config.defaultCwd);
    const model = request.model ?? deps.config.defaultModel;
    if (!model || model.startsWith("-") || model.includes("\0")) throw new Error("Invalid OMP model");
    if (request.thinking && !/^(off|minimal|low|medium|high|xhigh|max|auto)$/.test(request.thinking))
      throw new Error("Invalid OMP thinking level");
    executable(deps);
    const argv = [
      ...headlessArgv(deps.config.agentCommand, model),
      ...(request.thinking ? [`--thinking=${request.thinking}`] : []),
    ];
    if (!request.worktree && (request.branch || request.base))
      throw new Error("--branch and --base require --worktree");
    if (request.worktree && !isAbsolute(expandHome(request.worktree))) throw new Error("Use an absolute worktree path");
    if (request.base?.startsWith("-") || request.branch?.startsWith("-")) throw new Error("Invalid Git reference");
    records.store(receipt, { status: "pending", fingerprint });
    const worktree = request.worktree ? expandHome(request.worktree) : undefined;
    if (worktree)
      await nativeCli(deps, [
        "worktree",
        "add",
        `--cwd=${cwd}`,
        ...(request.branch ? [`--branch=${request.branch}`] : []),
        "--",
        worktree,
        ...(request.base ? [request.base] : []),
      ]);
    const actualCwd = worktree ? directory(worktree) : cwd;
    // The pending receipt names the reservation as soon as it exists, so an unconfirmed start can be inspected.
    const { session, runtime, ref } = await start(
      deps,
      { cwd: actualCwd, name: request.name ?? `remote-${id.slice(0, 8)}`, argv },
      (reserved) => records.store(receipt, { status: "pending", fingerprint, ref: formatRef(reserved) }),
    );
    records.store(records.path("session", session.session), {
      cwd: actualCwd,
      sessionFile: session.sessionFile,
      model: session.model,
    });
    const opened = { ...session, status: "opened", worktree: worktree ?? null, id };
    records.store(receipt, {
      ...opened,
      fingerprint,
      ...(request.text ? { delivery: { id, status: "unconfirmed" } } : {}),
    });
    if (!request.text) return opened;
    try {
      // Headless mutations go through the native command supervisor, never the session's own endpoint.
      const delivery = await runtime.remoteSend(ref, session.session, { id, text: request.text, delivery: "prompt" });
      const result = { ...opened, delivery };
      records.store(receipt, { ...result, fingerprint });
      return result;
    } catch (error) {
      const result = { ...opened, deliveryError: error instanceof Error ? error.message : String(error) };
      records.store(receipt, { ...result, fingerprint });
      return result;
    }
  });
}

export async function wakeRemoteSession(deps: FlowDeps, id: string): Promise<Session> {
  const records = new RemoteRecords(deps.config.stateDir);
  const path = records.path("session", id);
  return await records.exclusive(`session-${id}`, async () => {
    const saved = records.read(path);
    if (saved?.["closed"]) throw new Error("Explicitly closed OMP sessions cannot be woken remotely");
    if (saved?.["closePending"]) throw new Error("Remote close outcome is unconfirmed; refusing cold wake");
    const live = (await liveSessions(deps.config.stateDir)).find((row) => row.session === id);
    if (live) return live;
    const lane = (await deps.registry.list()).find((row) => row.session === id);
    if (lane && (statusOf(lane) === "closed" || lane.nativeCloseIntent || lane.hold))
      throw new Error("Closed or held lanes require explicit local reopen");
    // Registered lanes keep their own registry and ref contract; never spawn an unbound copy.
    if (lane) throw new Error("Registered lanes must be reconciled with Cataly's native reopen command");
    const file = saved?.["sessionFile"];
    const cwd = saved?.["cwd"];
    if (typeof file !== "string" || typeof cwd !== "string") throw new Error("No eligible saved Cataly remote session");
    const root = realpathSync(deps.config.sessionsDir);
    const exact = await resumeFile(deps, { key: id, session: id, sessionFile: file, cwd });
    const under = relative(root, exact);
    if (!under || under.startsWith("..") || isAbsolute(under) || !basename(exact).endsWith(".jsonl"))
      throw new Error("Saved session is outside the configured OMP sessions directory");
    const lease = object(JSON.parse(await nativeCli(deps, ["session", "lease", "--json", "--", id])));
    if (
      !Array.isArray(lease?.["held"]) ||
      !Array.isArray(lease["unknown"]) ||
      lease["held"].length ||
      lease["unknown"].length
    )
      throw new Error("OMP cannot confirm that the saved session is unowned");
    const { session } = await start(
      deps,
      {
        cwd: directory(cwd),
        name: `remote-${id.slice(0, 8)}`,
        argv: [...executable(deps), "--cataly-role", "lane"],
      },
      () => {},
      { file: exact, sessionId: id },
    );
    return session;
  });
}

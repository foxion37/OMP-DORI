import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_BINARY_ENV, nativeBinary } from "../native-binary.ts";
import type { HeadlessObservation, NativeLoopRole } from "./headless-protocol.ts";
import * as host from "./headless-record.ts";
import type { SessionRef, SessionRole } from "./types.ts";

type Resume = { readonly file: string; readonly sessionId: string };
type Env = Record<string, string | undefined>;
const WAIT_FOR_HOST = 65_000;
const MISSING_BINARY =
  "headless lanes, the lead and duty run on the native Cataly binary, and none is installed: reinstall Cataly " +
  `(see docs/releases.md), or set ${NATIVE_BINARY_ENV} to an absolute cataly built with ` +
  "`cargo build --locked --release`";

const liveAgent = (seen: HeadlessObservation, role: SessionRole): boolean =>
  seen.status !== "gone" &&
  seen.status !== "unknown" &&
  seen.status !== "error" &&
  seen.role === (role === "lane" ? "lane" : "cataly") &&
  (role === "lane" || seen.harnessRole === role) &&
  !!seen.sessionId &&
  !!seen.sessionFile;

const liveLoop = (seen: HeadlessObservation, role: NativeLoopRole): boolean =>
  seen.harnessRole === role && seen.role === undefined && seen.status === "working" && seen.pid !== undefined;

/** Agent roles run `<binary> headless-host <dir>`; a plain loop runs on Bun as its own scheduler process. */
async function spawnHost(dir: string, start: host.HostStart, binary: string | undefined) {
  const { env } = start;
  const log = binary === undefined ? openSync(join(dir, "loop.log"), "wx", 0o600) : undefined;
  const entry = binary === undefined ? join(import.meta.dir, "headless-loop.ts") : "headless-host";
  const child = (() => {
    try {
      return spawn(binary ?? process.execPath, [entry, dir], {
        detached: true,
        stdio: ["pipe", log ?? "ignore", log ?? "ignore"],
        // Secrets are streamed to the child, not persisted or inserted into argv.
        env: { PATH: env["PATH"], HOME: env["HOME"], TMPDIR: env["TMPDIR"] },
      });
    } finally {
      if (log !== undefined) closeSync(log);
    }
  })();
  const channel = child.stdin;
  if (!channel) throw new host.HeadlessError("headless supervisor input pipe unavailable");
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    channel.once("error", fail);
    channel.end(JSON.stringify(start), done);
  }).catch((error: unknown) => {
    throw new host.HeadlessError(`headless supervisor start unconfirmed (${String(error)})`);
  });
  child.unref();
  return child;
}

export async function startHost(
  stateDir: string,
  ref: SessionRef,
  argv: readonly string[],
  env: Env,
  resume?: Resume,
): Promise<HeadlessObservation> {
  const entry = host.laneEntry(stateDir, ref);
  if (!entry) throw new host.HeadlessError("headless reservation missing");
  const { dir, reservation } = entry;
  const role = reservation.role ?? "lane";
  const isLoop = role === "duty-loop" || role === "hourly-loop";
  // Lanes and the harness lead may resume their own transcript; duty and the plain loops always start fresh.
  if (isLoop !== (argv.length === 0) || (resume && role !== "lane" && role !== "lead"))
    throw new host.HeadlessError("native start role mismatch");
  if (existsSync(join(dir, "stopped.json"))) throw new host.HeadlessError("headless reservation has stopped");
  const binary = isLoop ? undefined : nativeBinary();
  if (!isLoop && binary === undefined) throw new host.HeadlessError(MISSING_BINARY);
  // A competing start/close gets the same exclusive file. Never retry a spawn after ambiguity.
  writeFileSync(join(dir, "started"), "", { flag: "wx", mode: 0o600 });
  for (const key of ["CATALY_HEADLESS_ID", "CATALY_ASK_LAUNCHED_LANE", "CATALY_HARNESS_ROLE"]) delete env[key];
  if (role === "lead" || role === "duty") env["CATALY_HARNESS_ROLE"] = role;
  const child = await spawnHost(
    dir,
    {
      argv: resume ? [...argv, `--resume=${resume.file}`] : argv,
      env,
      ...(resume ? { expectedResumeId: resume.sessionId } : {}),
    },
    binary,
  );
  const deadline = Date.now() + WAIT_FOR_HOST;
  do {
    const seen = await host.observeHost(stateDir, ref);
    if (isLoop ? liveLoop(seen, role) : liveAgent(seen, role)) return seen;
    if (seen.status === "gone" || child.exitCode !== null || child.signalCode !== null) {
      // The native host's stderr is not kept; name the binary so an old build without `headless-host` is diagnosable.
      const exit = child.exitCode ?? child.signalCode;
      const fallback =
        binary === undefined
          ? `headless ${role} process exited before proving startup`
          : `headless ${role} host \`${binary} headless-host\` exited${exit === null ? "" : ` (${exit})`} before ` +
            "proving startup; a binary without that subcommand is stale: rebuild or reinstall it";
      throw new host.HeadlessError(seen.detail ?? fallback);
    }
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new host.HeadlessError(`headless ${role} process did not prove startup before the deadline`);
}

export async function stopHarnessRole(
  stateDir: string,
  ref: SessionRef,
  role: Exclude<SessionRole, "lane">,
  sessionId?: string,
): Promise<void> {
  const entry = host.laneEntry(stateDir, ref);
  if (!entry || entry.reservation.role !== role) throw new host.HeadlessError("native harness reservation mismatch");
  const stopped = () => host.readPrivate<host.StopReceipt>(join(entry.dir, "stopped.json")) !== undefined;
  if (stopped()) return;
  if (!existsSync(join(entry.dir, "started"))) {
    await closeHost(stateDir, ref);
    return;
  }
  const seen = await host.observeHost(stateDir, ref);
  if (stopped()) return;
  if (role === "duty-loop" || role === "hourly-loop") {
    // After a stop was admitted the broker may still be draining the same pass.
    if (seen.harnessRole !== role || seen.pid === undefined)
      throw new host.HeadlessError("plain loop identity is unconfirmed; no process was signaled");
    await host.requestHost(stateDir, ref, { op: "stop-loop" }).catch((error: unknown) => {
      if (!(error instanceof host.HostTransportError) || !stopped()) throw error;
    });
  } else {
    if (!liveAgent(seen, role) || (sessionId && seen.sessionId !== sessionId))
      throw new host.HeadlessError("native role session identity is unconfirmed or changed");
    if (seen.held || seen.status !== "idle")
      throw new host.HeadlessError("native role is busy or awaiting an answer; no approval was touched");
    await closeHost(stateDir, ref, seen.sessionId);
  }
  const deadline = Date.now() + 5_000;
  while (!stopped() && Date.now() < deadline) await Bun.sleep(20);
  if (!stopped()) throw new host.HeadlessError("native role exit was not confirmed");
}

export async function closeHost(stateDir: string, ref: SessionRef, expectedSessionId?: string): Promise<void> {
  const entry = host.laneEntry(stateDir, ref);
  if (!entry || host.readPrivate<host.StopReceipt>(join(entry.dir, "stopped.json"))) return;
  if (!existsSync(join(entry.dir, "started"))) {
    // Competing start either already owns this record or will see that close reserved it.
    writeFileSync(join(entry.dir, "started"), "", { flag: "wx", mode: 0o600 });
    host.writePrivate(join(entry.dir, "stopped.json"), {});
    return;
  }
  const observed = await host.observeHost(stateDir, ref);
  if (observed.status === "gone") return;
  const bound = expectedSessionId ?? observed.sessionId;
  if (!bound) throw new host.HeadlessError("headless close has no confirmed native session identity");
  await host.requestHost(stateDir, ref, { op: "close", expectedSessionId: bound }).catch((error: unknown) => {
    if (
      !(error instanceof host.HostTransportError) ||
      host.readPrivate<host.StopReceipt>(join(entry.dir, "stopped.json"))?.closedSessionId !== bound
    )
      throw error;
  });
  if ((await host.observeHost(stateDir, ref)).status !== "gone")
    throw new host.HeadlessError("headless close not confirmed");
}

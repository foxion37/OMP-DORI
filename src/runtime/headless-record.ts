import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseCatalyRole } from "../../skills/cataly-mode/scripts/src/session-compat.ts";
import { type HeadlessObservation, type HeadlessRequest, object } from "./headless-protocol.ts";
import { HEADLESS_ADDRESS, type SessionInfo, type SessionRef, type SessionRole } from "./types.ts";

export type Reservation = {
  readonly ref: SessionRef;
  readonly name: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly role?: SessionRole;
};
export type Endpoint = { readonly socket: string; readonly key: string; readonly pid: number };
export type StopReceipt = { readonly detail?: string; readonly closedSessionId?: string };
export type HostStart = {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly expectedResumeId?: string;
};

export const dataDir = (stateDir: string): string => join(stateDir, "headless");

export const laneDir = (stateDir: string, ref: SessionRef): string => {
  if (ref.runtime !== "headless" || !HEADLESS_ADDRESS.test(ref.id)) throw new Error("invalid headless session ref");
  return join(dataDir(stateDir), ref.id);
};

export const privateDir = (dir: string): void => {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("headless state directory is not owner-only");
};

export const readPrivate = <T>(path: string): T | undefined => {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("headless state file is not owner-only");
    const value = object(JSON.parse(readFileSync(path, "utf8")));
    if (!value) throw new Error("invalid headless state record");
    return value as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const writePrivate = (path: string, value: object): void => {
  const tmp = `${path}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
};

export class HeadlessError extends Error {}
export class HostTransportError extends HeadlessError {}
type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function laneEntry(stateDir: string, ref: SessionRef): { dir: string; reservation: Reservation } | undefined {
  const dir = laneDir(stateDir, ref);
  if (!existsSync(dataDir(stateDir)) || !existsSync(dir)) return undefined;
  privateDir(dataDir(stateDir));
  privateDir(dir);
  const reservation = readPrivate<Reservation>(join(dir, "reservation.json"));
  if (
    !reservation ||
    reservation.ref?.runtime !== "headless" ||
    reservation.ref.id !== ref.id ||
    ![undefined, "lane", "lead", "duty", "duty-loop", "hourly-loop"].includes(reservation.role)
  )
    throw new HeadlessError("headless reservation identity unreadable");
  return { dir, reservation };
}

export async function requestHost<T>(stateDir: string, ref: SessionRef, request: HeadlessRequest): Promise<T> {
  const entry = laneEntry(stateDir, ref);
  if (!entry) throw new HeadlessError("headless lane reservation missing");
  const endpoint = readPrivate<Endpoint>(join(entry.dir, "endpoint.json"));
  if (
    !endpoint ||
    typeof endpoint.socket !== "string" ||
    !/^\/tmp\/cataly-rpc-[A-Za-z0-9]+\/socket$/.test(endpoint.socket)
  )
    throw new HeadlessError("headless host endpoint missing or invalid");
  let reply: Reply<T>;
  try {
    const res = await fetch("http://localhost/", {
      unix: endpoint.socket,
      method: "POST",
      headers: { authorization: endpoint.key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reply = (await res.json()) as Reply<T>;
    if (reply.ok !== true && reply.ok !== false) throw new Error("invalid response");
  } catch (error) {
    throw new HostTransportError(`headless local transport unconfirmed (${String(error)})`);
  }
  if (!reply.ok) throw new HeadlessError(reply.error);
  return reply.value;
}

export async function observeHost(stateDir: string, ref: SessionRef): Promise<HeadlessObservation> {
  const entry = laneEntry(stateDir, ref);
  const base = {
    ref: entry?.reservation.ref ?? ref,
    cwd: entry?.reservation.cwd ?? "",
    startedAt: entry?.reservation.startedAt ?? "",
    updatedAt: new Date().toISOString(),
    held: true,
    dialogs: [],
    recent: [],
  } as const;
  if (!entry) return { ...base, status: "gone" };
  const stopped = readPrivate<StopReceipt>(join(entry.dir, "stopped.json"));
  if (stopped) return { ...base, ...(stopped.detail ? { detail: stopped.detail } : {}), status: "gone" };
  if (!readPrivate<Endpoint>(join(entry.dir, "endpoint.json"))) return { ...base, status: "unknown" };
  try {
    const observation = await requestHost<Omit<HeadlessObservation, "role"> & { readonly role?: unknown }>(
      stateDir,
      ref,
      { op: "observe" },
    );
    const { role: rawRole, ...rest } = observation;
    const role = parseCatalyRole(rawRole);
    if (rawRole !== undefined && role === undefined) throw new HeadlessError("invalid headless runtime role");
    return role === undefined ? rest : { ...rest, role };
  } catch (error) {
    // Socket loss is not proof of exit. A broker killed externally cannot be rebound or signaled by PID.
    return { ...base, status: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function listHosts(stateDir: string, group: string | undefined): Promise<readonly SessionInfo[]> {
  const base = dataDir(stateDir);
  if (!existsSync(base)) return [];
  privateDir(base);
  const records = await Promise.all(
    readdirSync(base)
      .filter((id) => HEADLESS_ADDRESS.test(id))
      .map(async (id) => {
        const ref = { runtime: "headless", id } as const;
        const entry = laneEntry(stateDir, ref);
        if (!entry || (group !== undefined && group !== entry.reservation.ref.group)) return [];
        const s = await observeHost(stateDir, ref);
        return s.status === "gone"
          ? []
          : [
              {
                ref: s.ref,
                name: entry.reservation.name,
                title: entry.reservation.name,
                cwd: s.cwd,
                status: s.status,
                ...(s.role ? { agent: "omp" } : {}),
              },
            ];
      }),
  );
  return records.flat();
}

type Host = {
  start(start: HostStart, config: string): Promise<number>;
  handle(request: HeadlessRequest): Promise<unknown>;
  readonly closedSessionId: string | undefined;
};

export async function serveHost(dir: string, make: (reservation: Reservation) => Host): Promise<void> {
  privateDir(dir);
  const reservation = readPrivate<Reservation>(join(dir, "reservation.json"));
  if (!reservation) throw new Error("headless reservation missing");
  const host = make(reservation);
  const start = (await Bun.stdin.json()) as HostStart;
  if (!Array.isArray(start.argv) || !object(start.env)) throw new Error("invalid headless start");
  const config = join(dir, "host.yml");
  writeFileSync(config, "goal:\n  continuationModes: [rpc]\nask:\n  timeout: 0\n", { flag: "wx", mode: 0o600 });
  // Darwin Unix addresses cap at 104 bytes. This owner-only random directory is short and host-local.
  const sockDir = mkdtempSync("/tmp/cataly-rpc-");
  const socket = join(sockDir, "socket");
  const key = createHash("sha256").update(randomUUID()).update(randomUUID()).digest("hex");
  let inFlight = 0;
  const server = Bun.serve({
    unix: socket,
    maxRequestBodySize: 1024 * 1024,
    async fetch(req) {
      server.timeout(req, 60);
      const provided = req.headers.get("authorization");
      if (
        req.method !== "POST" ||
        !provided ||
        !/^[0-9a-f]{64}$/.test(provided) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(key))
      )
        return new Response(null, { status: 403 });
      const request = object(await req.json().catch(() => undefined));
      if (!request || typeof request["op"] !== "string") return new Response(null, { status: 400 });
      inFlight++;
      try {
        const value = await host.handle(request as HeadlessRequest);
        return Response.json({ ok: true, value });
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        inFlight--;
      }
    },
  });
  try {
    writePrivate(join(dir, "endpoint.json"), { socket, key, pid: process.pid });
    const code = await host.start(start, config);
    writePrivate(join(dir, "stopped.json"), {
      ...(code === 0 ? {} : { detail: `headless process exited (${code})` }),
      ...(host.closedSessionId === undefined ? {} : { closedSessionId: host.closedSessionId }),
    });
  } catch (error) {
    writePrivate(join(dir, "stopped.json"), { detail: error instanceof Error ? error.message : String(error) });
  } finally {
    // Let the operation waiting on native EOF receive its reply before taking the socket down.
    const deadline = Date.now() + 1_000;
    while (inFlight && Date.now() < deadline) await Bun.sleep(10);
    await server.stop(false);
    rmSync(sockDir, { recursive: true, force: true });
  }
}

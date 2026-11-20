import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStart } from "../../../../../src/release/process-cwd.ts";
import { discordApiBase } from "./discord.ts";
import { readPrivateAskFile } from "./discord-ask-mailbox.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

const TTL_MS = 30_000;
const REFRESH_MS = 5_000;
const MAX_BYTES = 65_536;
const MAX_CHANNELS = 1_024;
const RECEIPT_NAME = /^(\d{1,10})-[0-9a-f-]{36}\.json$/;
type Route = { owner: string; explicit: readonly string[]; watched: readonly string[] };
type Receipt = Route & {
  version: 1;
  pid: number;
  start: string;
  tokenDigest: string;
  apiBase: string;
  expiresAt: number;
};
export type DiscordAskReceiverPublication = { refresh(): void; suspend(): void; close(): void };
const owned = (uid: number) => process.getuid === undefined || uid === process.getuid();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const channelList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_CHANNELS && value.every(isDiscordSnowflake);

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & 0o077) !== 0)
    throw new Error("Discord ASK receiver directory is not private");
}

/** A reused PID, zombie, or a receipt from a previous Linux boot is not a receiver. */
function identity(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return processStart(String(pid));
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    if (fields[0] === "Z" || fields[0] === "X" || !start || !/^\d+$/.test(start)) return undefined;
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
  } catch {
    return undefined;
  }
}

function receipt(value: unknown, pid: number): Receipt | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const item = value as Partial<Receipt>;
  if (
    item.version !== 1 ||
    item.pid !== pid ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof item.start !== "string" ||
    item.start.length > 256 ||
    typeof item.apiBase !== "string" ||
    typeof item.tokenDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.tokenDigest) ||
    !isDiscordSnowflake(item.owner) ||
    !channelList(item.explicit) ||
    !channelList(item.watched) ||
    !item.explicit.every((channel) => item.watched!.includes(channel)) ||
    !Number.isSafeInteger(item.expiresAt)
  )
    return undefined;
  return item as Receipt;
}

/**
 * Local discovery only: exact token digest, private file, unexpired heartbeat, live process/start identity.
 * `watched` includes discovered scope-all channels and followed threads, NOT automatic Dori destinations.
 * Consumers may use those only for a registered lane thread; automatic Dori needs exactly one `explicit` ID.
 * Malformed, unavailable, insecure and stale receipts never turn discovery into a command failure.
 */
export function discordAskReceivers(
  stateDir: string,
  token: string,
): Array<{
  owner: string;
  explicit: readonly string[];
  watched: readonly string[];
}> {
  if (!token) return [];
  const root = join(stateDir, "discord-ask-receivers");
  const routes: Route[] = [];
  const tokenDigest = digest(token);
  try {
    const apiBase = discordApiBase(process.env["DORI_DISCORD_API_BASE"]);
    privateDirectory(root);
    for (const name of readdirSync(root)) {
      const match = RECEIPT_NAME.exec(name);
      if (!match) continue;
      const path = join(root, name);
      try {
        const raw = readPrivateAskFile(path, MAX_BYTES);
        if (raw === undefined) continue;
        const item = receipt(JSON.parse(raw), Number(match[1]));
        if (!item) continue;
        const now = Date.now();
        if (identity(item.pid) !== item.start) {
          unlinkSync(path);
          continue;
        }
        // A heartbeat may replace this pathname after the read; never unlink a merely expired snapshot.
        if (item.expiresAt <= now || item.expiresAt > now + TTL_MS) continue;
        if (item.tokenDigest === tokenDigest && item.apiBase === apiBase)
          routes.push({ owner: item.owner, explicit: item.explicit, watched: item.watched });
      } catch {
        // An absent, concurrently refreshed or untrusted receipt is not a working route.
      }
    }
  } catch {
    // Discovery must not require a state directory or rewrite persistent user settings.
  }
  return routes;
}

/** Call only after intake authenticates the bot and validates its owner/channel scope. All publication is best-effort. */
export function openDiscordAskReceiver(
  stateDir: string,
  token: string,
  owner: string,
  explicit: readonly string[],
  watched: () => readonly string[],
  progressWindowMs = Infinity,
): DiscordAskReceiverPublication {
  const root = join(stateDir, "discord-ask-receivers");
  const name = `${process.pid}-${randomUUID()}.json`;
  const path = join(root, name);
  const start = identity(process.pid);
  const tokenDigest = digest(token);
  let apiBase: string | undefined;
  try {
    apiBase = discordApiBase(process.env["DORI_DISCORD_API_BASE"]);
  } catch {
    /* Fail closed below. */
  }
  const configured = [...new Set(explicit)];
  let timer: NodeJS.Timeout | undefined;
  let active = false;
  let lastChannels: readonly string[] = [];
  let verifiedUntil = 0;
  let renewAt = 0;
  let closed = false;
  const remove = () => {
    try {
      privateDirectory(root);
      unlinkSync(path);
    } catch {
      // Process death and the short expiry remain authoritative if cleanup fails.
    }
  };
  const publish = () => {
    if (!active || closed || !start) return;
    let temp: string | undefined;
    try {
      const now = Date.now();
      if (now >= verifiedUntil) {
        suspend();
        return;
      }
      const current = watched();
      if (now < renewAt && current.length === lastChannels.length && current.every((id, i) => id === lastChannels[i]))
        return;
      const channels = [...new Set(current)];
      if (
        !token ||
        !apiBase ||
        !isDiscordSnowflake(owner) ||
        !channelList(configured) ||
        !channelList(channels) ||
        !configured.every((channel) => channels.includes(channel))
      )
        throw new Error("Invalid Discord ASK receiver route");
      const body: Receipt = {
        version: 1,
        pid: process.pid,
        start,
        tokenDigest,
        apiBase,
        owner,
        explicit: configured,
        watched: channels,
        expiresAt: Math.floor(Math.min(now + TTL_MS, verifiedUntil)),
      };
      const text = JSON.stringify(body);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Discord ASK receiver route exceeds size limit");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      privateDirectory(root);
      temp = join(root, `.${name}-${randomUUID()}`);
      writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
      lastChannels = [...current];
      renewAt = now + REFRESH_MS;
    } catch {
      renewAt = 0;
      remove();
    } finally {
      if (temp !== undefined) {
        try {
          unlinkSync(temp);
        } catch {
          /* Renamed or already removed. */
        }
      }
    }
  };
  const suspend = () => {
    active = false;
    verifiedUntil = 0;
    renewAt = 0;
    clearInterval(timer);
    timer = undefined;
    remove();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    suspend();
    process.removeListener("exit", close);
  };
  process.once("exit", close);
  return {
    /** Renew on schedule or immediately if the receiver's observed channel set changed. */
    refresh(): void {
      if (closed || !start) return;
      verifiedUntil = Date.now() + progressWindowMs;
      active = true;
      publish();
      if (timer === undefined) {
        timer = setInterval(publish, REFRESH_MS);
        timer.unref();
      }
    },
    suspend,
    close,
  };
}

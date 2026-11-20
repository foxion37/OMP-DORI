import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

const RETAIN_MS = 48 * 60 * 60 * 1_000;
const MAX_REPLY_BYTES = 16_384;
const TEXT_INTAKE_LEASE = "text-intake";
const TEXT_INTAKE_TTL_MS = 15_000;
const TEXT_INTAKE_RENEW_MS = 2_000;
const MAILBOX_SUBDIR = "discord-ask-replies";
const owned = (uid: number) => process.getuid === undefined || uid === process.getuid();
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
/** Reads only bounded, private regular files, without following the last path component. */
export function readPrivateAskFile(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat.uid) || (stat.mode & 0o077) !== 0 || stat.size > maxBytes)
      throw new Error("ASK file must be an owned, private regular file within the size limit");
    const bytes = Buffer.allocUnsafe(Math.min(stat.size, maxBytes) + 1);
    let size = 0;
    for (;;) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) return bytes.toString("utf8", 0, size);
      size += count;
      if (size === bytes.length) throw new Error("ASK file grew during the bounded read");
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & 0o077) !== 0)
    throw new Error("ASK mailbox directory is not private");
  return stat;
}

function paths(stateDir: string, channel: string, question: string) {
  const root = join(stateDir, MAILBOX_SUBDIR);
  return { root, exchange: join(root, `${channel}-${question}`) };
}

/** Publish atomically. Immutable files preserve the first write on receiver replay. */
function publishFile(dir: string, destination: string | { readonly replace: string }, text: string): boolean {
  const replace = typeof destination !== "string";
  const path = join(dir, replace ? destination.replace : destination);
  const temp = join(dir, `.partial-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let installed = true;
    try {
      if (replace) renameSync(temp, path);
      else linkSync(temp, path);
    } catch (error) {
      if (replace || !hasCode(error, "EEXIST")) throw error;
      installed = false;
    }
    const directory = openSync(dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return installed;
  } finally {
    rmSync(temp, { force: true });
  }
}

export type AskReply = { channel: string; message: string; reference: string | null; text: string };
type AskText = { readonly channel: string; readonly message: string; readonly text: string };
function encodeReply(text: string, plain = false): string {
  const answer = JSON.stringify(plain ? [text] : text);
  if (Buffer.byteLength(answer) > MAX_REPLY_BYTES) throw new Error("Discord ASK reply exceeds the local size limit");
  return answer;
}

function deliverReply(exchange: string, id: string, answer: string): void {
  const name = `reply-${id}`;
  publishFile(exchange, name, answer);
  if (readPrivateAskFile(join(exchange, "closed"), 1) !== undefined) rmSync(join(exchange, name), { force: true });
}

/** Call only after the Discord intake has verified the real owner and channel. */
export function routeDiscordAskReply(stateDir: string, message: AskReply, owner: string): boolean {
  const { channel, reference, message: id, text } = message;
  if (!isDiscordSnowflake(channel) || !isDiscordSnowflake(reference) || !isDiscordSnowflake(id)) return false;
  if (BigInt(id) <= BigInt(reference)) return false;
  const { root, exchange } = paths(stateDir, channel, reference);
  try {
    privateDirectory(root);
    privateDirectory(exchange);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (readPrivateAskFile(join(exchange, "owner"), 24) !== owner) return false;
  const closedPath = join(exchange, "closed");
  if (readPrivateAskFile(closedPath, 1) !== undefined) return true;
  if (Date.now() - lstatSync(exchange).birthtimeMs > RETAIN_MS) return true;
  deliverReply(exchange, id, encodeReply(text));
  return true;
}

function activeTextExchange(exchange: string, owner: string, now: number, messageAt: number): boolean {
  try {
    if (now - privateDirectory(exchange).birthtimeMs > RETAIN_MS) return false;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  const lease = readPrivateAskFile(join(exchange, TEXT_INTAKE_LEASE), 33)?.match(/^(\d{1,16}):(\d{1,16})$/);
  if (!lease) return false;
  const expires = Number(lease[2]);
  return (
    messageAt >= Number(lease[1]) &&
    expires > now &&
    expires <= now + TEXT_INTAKE_TTL_MS &&
    readPrivateAskFile(join(exchange, "owner"), 24) === owner &&
    readPrivateAskFile(join(exchange, "closed"), 1) === undefined
  );
}

/** Call only for authenticated, ordinary Discord text, never a reply or forward. */
export function routeUnreferencedDiscordAskText(stateDir: string, message: AskText, owner: string): boolean {
  const { channel, message: id, text } = message;
  if (!isDiscordSnowflake(channel) || !isDiscordSnowflake(id) || !isDiscordSnowflake(owner) || !text.trim())
    return false;
  const root = join(stateDir, MAILBOX_SUBDIR);
  try {
    privateDirectory(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  const claimName = `plain-${channel}-${owner}-${id}`;
  const claimPath = join(root, claimName);
  let question = readPrivateAskFile(claimPath, 20);
  const messageId = BigInt(id);
  const messageAt = Number((messageId >> 22n) + 1420070400000n);
  let answer: string | undefined;
  if (question === undefined) {
    const now = Date.now();
    const prefix = `${channel}-`;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(prefix)) continue;
      const candidate = name.slice(prefix.length);
      if (!isDiscordSnowflake(candidate) || BigInt(candidate) >= messageId) continue;
      if (!activeTextExchange(join(root, name), owner, now, messageAt)) continue;
      if (question !== undefined) {
        question = "ambiguous";
        break;
      }
      question = candidate;
    }
    if (question === undefined) return false;
    if (question !== "ambiguous") answer = encodeReply(text, true);
    if (!publishFile(root, claimName, question)) question = readPrivateAskFile(claimPath, 20);
  }
  if (question === "ambiguous") return false;
  if (!isDiscordSnowflake(question) || BigInt(question) >= messageId)
    throw new Error("Discord ASK text claim is invalid");
  const exchange = join(root, `${channel}-${question}`);
  // A replay never selects another exchange. If close raced the claim, consume without reviving it.
  if (activeTextExchange(exchange, owner, Date.now(), messageAt))
    deliverReply(exchange, id, answer ?? encodeReply(text, true));
  return true;
}
export function openDiscordAskMailbox(stateDir: string, channel: string, question: string, owner: string) {
  if (![channel, question, owner].every(isDiscordSnowflake)) throw new Error("Invalid Discord ASK mailbox identity");
  const { root, exchange } = paths(stateDir, channel, question);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  privateDirectory(root);
  const cutoff = Date.now() - RETAIN_MS;
  for (const name of readdirSync(root)) {
    const isReceipt = /^(?:plain-\d{1,20}-\d{1,20}-\d{1,20}|\.partial-[\da-f-]{36})$/.test(name);
    if (!isReceipt && !/^\d{1,20}-\d{1,20}$/.test(name)) continue;
    const status = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (
      status &&
      (isReceipt ? status.isFile() : status.isDirectory()) &&
      owned(status.uid) &&
      status.birthtimeMs < cutoff
    )
      rmSync(join(root, name), { recursive: !isReceipt, force: true });
  }
  mkdirSync(exchange, { mode: 0o700 });
  publishFile(exchange, "owner", owner);
  let refreshedAt: number | undefined;
  let openedAt: number | undefined;
  let closed = false;
  return {
    refreshTextIntake(): void {
      const now = Date.now();
      if (closed || (refreshedAt !== undefined && now >= refreshedAt && now - refreshedAt < TEXT_INTAKE_RENEW_MS))
        return;
      openedAt ??= now;
      publishFile(exchange, { replace: TEXT_INTAKE_LEASE }, `${openedAt}:${now + TEXT_INTAKE_TTL_MS}`);
      refreshedAt = now;
    },
    replies(seen: ReadonlySet<string>): Array<{ id: string; text: string; plain?: true }> {
      return readdirSync(exchange)
        .filter((name) => /^reply-\d{1,20}$/.test(name))
        .map((name) => name.slice(6))
        .filter((id) => !seen.has(id))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .flatMap<{ id: string; text: string; plain?: true }>((id) => {
          const raw = readPrivateAskFile(join(exchange, `reply-${id}`), MAX_REPLY_BYTES);
          const text: unknown = raw === undefined ? undefined : JSON.parse(raw);
          if (typeof text === "string") return [{ id, text }];
          return Array.isArray(text) && text.length === 1 && typeof text[0] === "string"
            ? [{ id, text: text[0], plain: true }]
            : [];
        });
    },
    close(): void {
      publishFile(exchange, "closed", "1");
      closed = true;
      for (const name of readdirSync(exchange))
        if (/^reply-\d{1,20}$/.test(name)) rmSync(join(exchange, name), { force: true });
    },
  };
}

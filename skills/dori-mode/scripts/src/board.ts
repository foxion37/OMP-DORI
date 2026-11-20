import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { takeLock } from "./checkpoint-lock.ts";
import { Discord } from "./messenger/discord.ts";
import { fetchHttp, guardText, type Http, MessengerError } from "./messenger/http.ts";
import { Telegram } from "./messenger/telegram.ts";
import type { Clock } from "./run.ts";

export class BoardError extends Error {}
export type BoardTarget = { readonly platform: "discord" | "telegram"; readonly to: string; readonly thread?: number };
type BoardRecord = {
  readonly target: BoardTarget;
  readonly messageId?: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly pending: boolean;
};

const isMessageId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
const unconfirmedDelivery = (detail: string) =>
  new BoardError(
    `board delivery unconfirmed${detail}; the write may have succeeded. Inspect the original destination before attempting recovery; do not resend.`,
  );

/** An ambiguous send is never replayed, including after a process crash. Recovery requires an explicit message ID. */
export const updateBoard = async (options: {
  readonly stateDir: string;
  readonly target: BoardTarget;
  readonly token: string;
  readonly clock: Clock;
  readonly body: string;
  readonly messageId?: string;
  readonly http?: Http;
}): Promise<{ readonly action: "posted" | "edited" | "unchanged"; readonly messageId: string }> => {
  const { stateDir, target, token, clock, body, messageId } = options;
  guardText(body);
  const limit = target.platform === "discord" ? 2000 : 4096;
  if (!body.trim() || body.length > limit - 40) throw new BoardError("board body must fit in one message");
  if (messageId !== undefined && !isMessageId(messageId)) throw new BoardError("invalid board message ID");
  const dir = join(stateDir, "boards");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${createHash("sha256").update(JSON.stringify(target)).digest("hex")}.json`);
  const held = takeLock(`${path}.lock`, clock.now(), (m) => new BoardError(m), { keepLiveOwner: true });
  if (typeof held === "string") throw new BoardError("board is being updated by another process");
  const persist = (record: BoardRecord) => {
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const directory = openSync(dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  };
  let freshCreate = false;
  try {
    let previous: BoardRecord | undefined;
    if (existsSync(path)) {
      try {
        previous = JSON.parse(readFileSync(path, "utf8")) as BoardRecord;
        if (
          !previous ||
          JSON.stringify(previous.target) !== JSON.stringify(target) ||
          typeof previous.body !== "string" ||
          typeof previous.updatedAt !== "string" ||
          typeof previous.pending !== "boolean" ||
          (previous.messageId !== undefined && !isMessageId(previous.messageId)) ||
          (!previous.pending && !previous.messageId)
        )
          throw new Error("invalid board record");
      } catch {
        throw new BoardError("board record unreadable; inspect it before any delivery");
      }
    }
    // Telegram edits are scoped to the chat, not the topic, and there is no read-only message lookup.
    if (target.platform === "telegram" && !previous?.messageId && (messageId !== undefined || previous?.pending))
      throw new BoardError(
        "cannot verify an unbound Telegram board message for this destination; recovery requires a locally recorded message ID (never auto-resend)",
      );
    if (previous?.pending && !messageId)
      throw new BoardError(
        "board delivery unconfirmed; inspect the destination, then supply --message ID (never auto-resend)",
      );
    if (messageId && previous?.messageId && messageId !== previous.messageId)
      throw new BoardError("--message does not match the recorded board");
    const id = messageId ?? previous?.messageId;
    if (previous && !previous.pending && previous.body === body && id === previous.messageId) {
      return { action: "unchanged", messageId: previous.messageId ?? "" };
    }
    const updatedAt = new Date(clock.now()).toISOString();
    const record = { target, body, updatedAt, ...(id ? { messageId: id } : {}) };
    freshCreate = !previous && !id;
    persist({ ...record, pending: true });
    const http = options.http ?? fetchHttp;
    const text = `${body}\nUpdated ${updatedAt}`;
    let delivered: unknown;
    if (target.platform === "discord") {
      const discord = new Discord(http, clock, token);
      const messagesPath = `/channels/${target.to}/messages`;
      const message = await discord.call<{ readonly id?: unknown } | null>(
        id ? "PATCH" : "POST",
        id ? `${messagesPath}/${id}` : messagesPath,
        { content: text, allowed_mentions: { parse: [] } },
      );
      delivered = id ?? message?.id;
    } else {
      const telegram = new Telegram(http, clock, token);
      const where = { chatId: target.to, ...(target.thread === undefined ? {} : { threadId: target.thread }) };
      if (id) {
        if (!Number.isSafeInteger(Number(id))) throw new BoardError("invalid Telegram message ID");
        await telegram.edit(where, Number(id), text);
        delivered = id;
      } else delivered = String(await telegram.send(where, text));
    }
    if (!isMessageId(delivered)) throw unconfirmedDelivery(" (missing message ID)");
    persist({ ...record, messageId: delivered, pending: false });
    return { action: id ? "edited" : "posted", messageId: delivered };
  } catch (error) {
    // Only a confirmed 4xx rejection lets a subsequent invocation attempt a fresh create.
    if (
      freshCreate &&
      error instanceof MessengerError &&
      error.outcome === "rejected" &&
      error.status >= 400 &&
      error.status < 500
    ) {
      unlinkSync(path);
      const directory = openSync(dir, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    if (error instanceof MessengerError && error.outcome === "uncertain") {
      throw unconfirmedDelivery(error.status >= 500 ? " (server error)" : "");
    }
    throw error;
  } finally {
    held();
  }
};

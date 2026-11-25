/**
 * Test-only monitor side of the head-admission IPC wire, standing in for the native Rust monitor so the extension's
 * admission contract stays covered without a native build. Mirrors native/src/discord admission ordering.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DiscordInbound } from "../../skills/cataly-mode/scripts/src/messenger/discord-inbound-api.ts";
import type { DiscordInboundQueue } from "../../skills/cataly-mode/scripts/src/messenger/discord-inbound-queue.ts";
import { discordSourceFingerprint } from "../../skills/cataly-mode/scripts/src/messenger/discord-source-fingerprint.ts";
import type { HeadInput, HeadReply } from "../../skills/cataly-mode/scripts/src/messenger/head-admission.ts";
import { HEAD_ADMISSION_PROTOCOL } from "../../skills/cataly-mode/scripts/src/messenger/head-admission-protocol.ts";
import { headUnresolved } from "../../skills/cataly-mode/scripts/src/messenger/head-admission-state.ts";

const admissionMode = () => process.env["CATALY_MONITOR_ADMISSION"];

/** One IPC exchange, never an inferred acknowledgement from stdout or process exit. */
const exchange = (input: HeadInput, signal?: AbortSignal): Promise<HeadReply> => {
  signal?.throwIfAborted();
  const send = process.send?.bind(process);
  if (!send || !process.connected) return Promise.reject(headUnresolved());
  const request = randomUUID();
  const protocol = HEAD_ADMISSION_PROTOCOL;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off("message", answer);
      process.off("disconnect", disconnected);
      signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      cleanup();
      reject(signal?.reason);
    };
    const disconnected = () => {
      cleanup();
      reject(headUnresolved());
    };
    const answer = (raw: unknown) => {
      if (raw === null || typeof raw !== "object" || !("request" in raw) || raw.request !== request) return;
      cleanup();
      if (!("protocol" in raw) || raw.protocol !== protocol || !("outcome" in raw)) return reject(headUnresolved());
      if (raw.outcome === "unresolved") return resolve(raw as HeadReply);
      if (!("headFile" in raw) || typeof raw.headFile !== "string" || !isAbsolute(raw.headFile))
        return reject(headUnresolved());
      if (!("headPid" in raw) || !Number.isSafeInteger(raw.headPid) || (raw.headPid as number) <= 0)
        return reject(headUnresolved());
      if (raw.outcome === "ready") return resolve(raw as HeadReply);
      if (
        (raw.outcome !== "accepted" && raw.outcome !== "rejected") ||
        !("receipt" in raw) ||
        typeof raw.receipt !== "string" ||
        raw.receipt.length === 0
      )
        return reject(headUnresolved());
      resolve(raw as HeadReply);
    };
    process.on("message", answer);
    process.once("disconnect", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      send({ ...input, protocol, request });
    } catch {
      disconnected();
    }
  });
};

/** Reconcile the retained source even when REST history no longer contains it. Never dispatch here. */
export const reconcileHead = async (queue: DiscordInboundQueue, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  for (let pending = queue.unresolved(); pending; pending = queue.unresolved()) {
    if (admissionMode() !== "1") throw headUnresolved();
    const reply = await exchange(
      {
        op: "reconcile",
        identity: pending.identity,
        fingerprint: pending.fingerprint,
        headFile: pending.headFile,
      },
      signal,
    );
    signal?.throwIfAborted();
    if ((reply.outcome !== "accepted" && reply.outcome !== "rejected") || reply.headFile !== pending.headFile)
      throw headUnresolved();
    queue.receipt(pending.identity, reply.outcome, reply.receipt);
  }
  signal?.throwIfAborted();
  queue.commitReceipts();
};

/** The existing SQLite queue owns both raw events and their original head-admission attempts. */
export const headEmitter = (
  queue: DiscordInboundQueue,
  botId: string,
  ownerId: string,
  format: (message: DiscordInbound, signal?: AbortSignal) => string | Promise<string>,
) => {
  const mode = admissionMode();
  if (mode !== undefined && mode !== "1") throw headUnresolved();
  const native = mode === "1";
  if (native && (!process.send || !process.connected)) throw headUnresolved();
  return async (message: DiscordInbound, signal?: AbortSignal): Promise<void> => {
    await reconcileHead(queue, signal);
    const cursor = queue.storeFor(message.channel).load();
    if (
      cursor !== undefined &&
      BigInt(message.message) <= BigInt(cursor) &&
      !queue.has(message.channel, message.message)
    )
      return;
    const identity = [botId, ownerId, message.channel, message.message].join(":");
    const fingerprint = discordSourceFingerprint(message);
    const previous = queue.admission(identity, fingerprint);
    if (previous && previous.outcome !== "unresolved") return;
    const content = await format(message, signal);
    signal?.throwIfAborted();
    if (!native) {
      console.log(content); // Console output cannot settle any earlier native attempt.
      return;
    }
    const input = { identity, fingerprint, content };
    let headFile = previous?.headFile;
    let reply = await exchange(
      { ...input, op: "prepare", ...(previous ? { headFile: previous.headFile } : {}) },
      signal,
    );
    signal?.throwIfAborted();
    if (reply.outcome === "unresolved" || (headFile !== undefined && reply.headFile !== headFile))
      throw headUnresolved();
    if (reply.outcome === "ready") {
      if (previous) throw headUnresolved(); // Absence of a receipt never authorizes another dispatch.
      headFile = reply.headFile;
      queue.attempt({ identity, fingerprint, headFile, headPid: reply.headPid, source: message });
      reply = await exchange({ ...input, op: "dispatch", headFile }, signal);
    } else if (!previous) {
      headFile = reply.headFile;
      queue.attempt({ identity, fingerprint, headFile, headPid: reply.headPid, source: message });
    }
    if ((reply.outcome !== "accepted" && reply.outcome !== "rejected") || reply.headFile !== headFile)
      throw headUnresolved();
    signal?.throwIfAborted();
    queue.receipt(identity, reply.outcome, reply.receipt);
  };
};

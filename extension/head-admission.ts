import { isAbsolute } from "node:path";
import { routeNativeHead } from "../skills/cataly-mode/scripts/src/messenger/native-routing.ts";
import { isHeadAdmissionProtocol } from "../skills/cataly-mode/scripts/src/messenger/head-admission-protocol.ts";
import type { HeadReply, HeadRequest, HeadResult } from "../skills/cataly-mode/scripts/src/messenger/head-admission.ts";
import { MONITOR_MESSAGE } from "../skills/cataly-mode/scripts/src/session-compat.ts";
import { hasHeadReceipt, headReceipt } from "./head-receipt.ts";

type Head = { id: string; file: string; entries(): readonly unknown[]; ensureOnDisk(): Promise<void> };
type AdmissionDetails = { ompCatalyAdmission: { identity: string; fingerprint: string } };
type Binding = {
  source: number;
  session: string;
  isCurrent(): boolean;
  accepts(content: string): boolean;
  deliver(content: string, details: AdmissionDetails): void | Promise<void>;
};
type Pending = {
  source: number;
  fingerprint: string;
  headFile: string;
  promise: Promise<HeadResult>;
  resolve(value: HeadResult): void;
};

/** One admission at a time per original identity; only native on-disk receipts finish a dispatch. */
export class HeadAdmissions {
  readonly #pending = new Map<string, Pending>();
  readonly #serial = new Map<string, Promise<HeadResult>>();
  constructor(
    private readonly current: () => Head | undefined,
    private readonly reject: (details: AdmissionDetails) => void,
    private readonly changed: (pending: number, unresolved?: string) => void,
  ) {}

  async receive(raw: unknown, binding: Binding): Promise<HeadReply> {
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("request" in raw) ||
      typeof raw.request !== "string" ||
      raw.request.length === 0 ||
      raw.request.length > 64 ||
      !("protocol" in raw) ||
      !isHeadAdmissionProtocol(raw.protocol) ||
      !("op" in raw) ||
      (raw.op !== "prepare" && raw.op !== "dispatch" && raw.op !== "reconcile") ||
      !("identity" in raw) ||
      typeof raw.identity !== "string" ||
      !/^[1-9][0-9]{0,19}(?::[1-9][0-9]{0,19}){3}$/.test(raw.identity) ||
      !("fingerprint" in raw) ||
      typeof raw.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.fingerprint) ||
      (raw.op !== "reconcile" &&
        (!("content" in raw) || typeof raw.content !== "string" || Buffer.byteLength(raw.content) > 1024 * 1024)) ||
      (raw.op === "reconcile" && !("headFile" in raw)) ||
      ("headFile" in raw && (typeof raw.headFile !== "string" || !isAbsolute(raw.headFile)))
    )
      throw new Error("invalid head admission request");
    const request = raw as HeadRequest;
    const before = this.#serial.get(request.identity) ?? Promise.resolve({ outcome: "unresolved" } as const);
    const result = before.then(() => this.#receive(request, binding)).catch(() => ({ outcome: "unresolved" }) as const);
    this.#serial.set(request.identity, result);
    try {
      const reply = await result;
      if (reply.outcome === "unresolved") this.changed(this.#pending.size, request.identity);
      return { protocol: request.protocol, request: request.request, ...reply };
    } finally {
      if (this.#serial.get(request.identity) === result) this.#serial.delete(request.identity);
    }
  }

  async #receive(request: HeadRequest, binding: Binding): Promise<HeadResult> {
    const head = this.current();
    if (!head || head.id !== binding.session) return { outcome: "unresolved" };
    await head.ensureOnDisk();
    const headFile = request.headFile ?? head.file;
    const checkDisk = headFile !== head.file || hasHeadReceipt(head.entries(), request.identity);
    const accepts =
      request.op === "dispatch" && headFile === head.file && binding.isCurrent() && binding.accepts(request.content);
    const native = routeNativeHead({
      op: request.op,
      file: headFile,
      identity: request.identity,
      fingerprint: request.fingerprint,
      check_disk: checkDisk,
      binding: request.headFile === undefined ? "new" : headFile === head.file ? "original" : "other",
      accepts,
    });
    const decision = native ? await native : undefined;
    if (decision && "receipt" in decision)
      return { outcome: decision.action, receipt: decision.receipt, headFile, headPid: process.pid };
    if (!decision && checkDisk) {
      const receipt = await headReceipt(headFile, request.identity, request.fingerprint);
      if (receipt) return { ...receipt, headFile, headPid: process.pid };
    }
    if (!binding.isCurrent() || this.current()?.id !== head.id || this.current()?.file !== head.file)
      return { outcome: "unresolved" };
    // An earlier attempted delivery without its original receipt is quarantined, not replayed into a new head.
    if (
      decision?.action === "unresolved" ||
      request.op === "reconcile" ||
      (request.op === "prepare" && request.headFile !== undefined)
    )
      return { outcome: "unresolved" };
    // Even a deliberate rejection follows the receiver's durable attempt record.
    if (request.op === "prepare")
      return !decision || decision.action === "ready"
        ? { outcome: "ready", headFile: head.file, headPid: process.pid }
        : { outcome: "unresolved" };
    if (request.headFile !== head.file) return { outcome: "unresolved" };
    if (decision?.action === "reject" || (!decision && !accepts)) {
      this.reject({ ompCatalyAdmission: { identity: request.identity, fingerprint: request.fingerprint } });
      await head.ensureOnDisk();
      const rejected = await headReceipt(head.file, request.identity, request.fingerprint);
      return rejected ? { ...rejected, headFile: head.file, headPid: process.pid } : { outcome: "unresolved" };
    }
    if (decision && decision.action !== "deliver") return { outcome: "unresolved" };
    const pending = {
      ...Promise.withResolvers<HeadResult>(),
      source: binding.source,
      fingerprint: request.fingerprint,
      headFile: head.file,
    };
    this.#pending.set(request.identity, pending);
    try {
      this.changed(this.#pending.size);
      const delivered = Promise.resolve(
        binding.deliver(request.content, {
          ompCatalyAdmission: { identity: request.identity, fingerprint: request.fingerprint },
        }),
      ).then(() => pending.promise);
      // Stop releases the receipt wait even during async delivery; its later rejection remains observed.
      return await Promise.race([pending.promise, delivered]);
    } finally {
      this.#pending.delete(request.identity);
      this.changed(this.#pending.size);
    }
  }

  /** Check message_end against disk; neither a notification nor sendMessage returning is a receipt. */
  async messageEnded(event: unknown): Promise<void> {
    const message = (
      event as {
        message?: {
          customType?: string;
          details?: { ompCatalyAdmission?: { identity?: string; fingerprint?: string } };
        };
      } | null
    )?.message;
    const admission = message?.customType === MONITOR_MESSAGE ? message.details?.ompCatalyAdmission : undefined;
    if (typeof admission?.identity !== "string") return;
    const pending = this.#pending.get(admission.identity);
    if (!pending || pending.fingerprint !== admission.fingerprint) return;
    try {
      // Native message_end persistence is queued before handlers; an atomic batch can still defer the disk write.
      // Publish the current head before readback, without forcing a different session onto disk.
      const head = this.current();
      if (head?.file === pending.headFile) await head.ensureOnDisk();
      const receipt = await headReceipt(pending.headFile, admission.identity, pending.fingerprint);
      pending.resolve(
        receipt ? { ...receipt, headFile: pending.headFile, headPid: process.pid } : { outcome: "unresolved" },
      );
    } catch {
      pending.resolve({ outcome: "unresolved" });
    }
  }

  /** A native session transition does not turn queued asides into accepted input. */
  stop(source?: number): void {
    for (const pending of this.#pending.values())
      if (source === undefined || pending.source === source) pending.resolve({ outcome: "unresolved" });
  }
}

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { discordNativeBinary } from "../../../../../src/native-binary.ts";

const LIMIT = 128 * 1024;
const WAIT_MS = 10_000;
const PENDING_LIMIT = 32;
const PENDING_BYTES = 512 * 1024;

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly bytes: number;
};

class RoutingPipe {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #pending = new Map<number, Pending>();
  #id = 0;
  #pendingBytes = 0;
  #closed = false;

  constructor(binary: string) {
    // No inherited credentials, shell, or diagnostic pipe carrying caller data.
    this.#child = spawn(binary, ["routing"], { stdio: ["pipe", "pipe", "ignore"], env: {} });
    const read = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    read.on("line", (line) => this.#answer(line));
    read.once("close", () => this.#fail());
    this.#child.once("error", () => this.#fail());
    this.#child.stdin.on("error", () => this.#fail());
    this.#child.stdout.on("error", () => this.#fail());
    this.#keepAlive(false);
  }

  get closed(): boolean {
    return this.#closed;
  }

  #keepAlive(active: boolean): void {
    if (active) this.#child.ref();
    else this.#child.unref();
    for (const stream of [this.#child.stdin, this.#child.stdout]) {
      if (active && "ref" in stream && typeof stream.ref === "function") stream.ref();
      if (!active && "unref" in stream && typeof stream.unref === "function") stream.unref();
    }
  }

  #fail(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill();
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Native Cataly routing stopped; admission remains unsettled"));
    }
    this.#pendingBytes = 0;
    this.#pending.clear();
    this.#keepAlive(false);
  }

  close(): void {
    this.#fail();
  }

  #answer(line: string): void {
    if (Buffer.byteLength(line) > LIMIT) return this.#fail();
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      return this.#fail();
    }
    if (!reply || typeof reply !== "object" || !("id" in reply) || typeof reply.id !== "number") return this.#fail();
    const request = this.#pending.get(reply.id);
    if (!request) return this.#fail();
    this.#pending.delete(reply.id);
    this.#pendingBytes -= request.bytes;
    clearTimeout(request.timer);
    if ("error" in reply && typeof reply.error === "string") request.reject(new Error(reply.error));
    else if ("value" in reply) request.resolve(reply.value);
    else {
      request.reject(new Error("Invalid native routing response"));
      this.#fail();
    }
    if (this.#pending.size === 0) this.#keepAlive(false);
  }

  request(command: object): Promise<unknown> {
    if (this.#closed || this.#pending.size >= PENDING_LIMIT) throw new Error("Native Cataly routing is unavailable");
    const id = (this.#id = (this.#id + 1) >>> 0);
    const line = `${JSON.stringify({ ...command, id })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > LIMIT) throw new Error("Native Cataly routing request is oversized");
    if (this.#pendingBytes + bytes > PENDING_BYTES) throw new Error("Native Cataly routing backlog is full");
    return new Promise((resolve, reject) => {
      this.#keepAlive(true);
      this.#pendingBytes += bytes;
      this.#pending.set(id, { bytes, resolve, reject, timer: setTimeout(() => this.#fail(), WAIT_MS) });
      this.#child.stdin.write(line, (error) => {
        if (error) this.#fail();
      });
    });
  }
}

let selected: { readonly binary: string; readonly pipe: RoutingPipe } | undefined;

/** Distinguish absence (no native binary) from an unknown native outcome (never replay). */
export function nativeRouting(command: object): Promise<unknown> | undefined {
  const binary = discordNativeBinary();
  if (selected && selected.binary !== binary) {
    selected.pipe.close();
    selected = undefined;
  }
  if (!binary) return undefined;
  if (!selected || selected.pipe.closed) selected = { binary, pipe: new RoutingPipe(binary) };
  return selected.pipe.request(command);
}

export type HeadRoute =
  | { readonly action: "accepted" | "rejected"; readonly receipt: string }
  | { readonly action: "ready" | "deliver" | "reject" | "unresolved" };

type HeadRequest = {
  readonly op: "prepare" | "dispatch" | "reconcile";
  readonly file: string;
  readonly identity: string;
  readonly fingerprint: string;
  readonly check_disk: boolean;
  readonly binding: "new" | "original" | "other";
  readonly accepts: boolean;
};

export function routeNativeHead(request: HeadRequest): Promise<HeadRoute> | undefined {
  return nativeRouting({ route: "head", ...request })?.then((reply) => {
    if (reply && typeof reply === "object" && "action" in reply) {
      switch (reply.action) {
        case "accepted":
        case "rejected":
          if ("receipt" in reply && typeof reply.receipt === "string" && reply.receipt)
            return { action: reply.action, receipt: reply.receipt };
          break;
        case "ready":
        case "deliver":
        case "reject":
        case "unresolved":
          return { action: reply.action };
      }
    }
    throw new Error("Invalid native head admission response");
  });
}

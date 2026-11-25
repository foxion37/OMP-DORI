import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LeadReply = { re: string; text: string; start: number };

/** Persisted offsets advance only after speech AND playback, never on the commentary acknowledgement. */
export class Replies {
  readonly file: string;
  private readonly stateFile: string;
  private scanned = 0;
  private readOffset = 0;
  private partial = Buffer.alloc(0);
  private identity: string | undefined;
  private readonly queue: LeadReply[] = [];

  constructor(
    directory: string,
    private readonly log: (line: string) => void,
  ) {
    this.file = join(directory, "lead-replies.jsonl");
    this.stateFile = join(directory, "lead-replies.state.json");
    if (existsSync(this.stateFile)) {
      const state: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (
        !state ||
        typeof state !== "object" ||
        !("offset" in state) ||
        typeof state.offset !== "number" ||
        !Number.isSafeInteger(state.offset) ||
        state.offset < 0
      )
        throw new Error("Invalid voice reply offset; restore the reply ledger before starting voice");
      this.scanned = this.readOffset = state.offset;
      this.identity = "identity" in state && typeof state.identity === "string" ? state.identity : undefined;
    }
  }

  scan(): void {
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const info = fstatSync(fd, { bigint: true });
      // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. Preserve all bits across scans and persisted receipts.
      const exact = `v2:${info.dev}:${info.ino}`;
      const identity = info.ino === 0n ? `${exact}:${info.birthtimeNs}` : exact;
      const sizeOnDisk = Number(info.size);
      if ((this.identity && this.identity !== identity) || sizeOnDisk < this.readOffset) {
        this.scanned = this.readOffset = 0;
        this.partial = Buffer.alloc(0);
        this.queue.length = 0;
      }
      this.identity = identity;
      if (sizeOnDisk === this.readOffset) return;
      const bytes = Buffer.alloc(sizeOnDisk - this.readOffset);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, this.readOffset + size);
        if (count === 0) break;
        size += count;
      }
      this.readOffset += size;
      const data = this.partial.length
        ? Buffer.concat([this.partial, bytes.subarray(0, size)])
        : bytes.subarray(0, size);
      let cursor = 0;
      for (;;) {
        const end = data.indexOf(10, cursor);
        if (end < 0) break; // Retain incomplete UTF-8 bytes without rereading them on every tick.
        const start = this.scanned;
        const line = data.subarray(cursor, end).toString("utf8").trim();
        this.scanned += end + 1 - cursor;
        cursor = end + 1;
        if (!line) continue;
        try {
          const reply: unknown = JSON.parse(line);
          if (
            !reply ||
            typeof reply !== "object" ||
            !("text" in reply) ||
            typeof reply.text !== "string" ||
            !reply.text.trim()
          )
            throw new Error("Invalid reply");
          this.queue.push({
            re: "re" in reply && typeof reply.re === "string" ? reply.re : "",
            text: reply.text,
            start,
          });
        } catch {
          this.log("VOICE_REPLY_INVALID_LINE");
        }
      }
      this.partial = Buffer.from(data.subarray(cursor));
    } finally {
      closeSync(fd);
    }
  }

  first(): LeadReply | undefined {
    return this.queue[0];
  }

  spoken(reply: LeadReply): void {
    // A replaced log cannot be acknowledged by an old session's in-flight reply.
    if (this.queue[0] !== reply) return;
    const offset = this.queue[1]?.start ?? this.scanned;
    writeFileSync(`${this.stateFile}.tmp`, `${JSON.stringify({ offset, identity: this.identity })}\n`, { mode: 0o600 });
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
    this.queue.shift();
  }
}

export type ReplyFlight = {
  reply: LeadReply;
  eventId: string;
  sentAt: number;
  ackedAt?: number;
  spokenChars: number;
  playbackGeneration: number;
  firstSpeechFrame?: number | undefined;
  text: string;
  end: number;
};
export const replySpokenEnough = (flight: ReplyFlight): boolean =>
  flight.ackedAt !== undefined &&
  flight.spokenChars >=
    Math.min(
      flight.text.replace(/\s/g, "").length,
      Math.max(8, Math.floor(flight.text.replace(/\s/g, "").length * 0.3)),
    );

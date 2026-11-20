import { closeSync, mkdtempSync, openSync, rmdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Raw bytes before LF. A larger line is preserved on disk, never filtered as a fragment. */
const LINE_MAX_BYTES = 64 * 1024;

export class MonitorOutputFile {
  readonly path: string;
  #fd: number | undefined;
  bytes = 0;

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), "omp-dori-monitor-"));
    this.path = join(dir, "output");
    try {
      this.#fd = openSync(this.path, "wx", 0o600);
    } catch (error) {
      rmdirSync(dir);
      throw error;
    }
  }

  write(data: Uint8Array): void {
    if (this.#fd === undefined) throw new Error("monitor output file is closed");
    let offset = 0;
    try {
      while (offset < data.byteLength) {
        const written = writeSync(this.#fd, data, offset, data.byteLength - offset);
        if (written === 0) throw new Error("monitor output write made no progress");
        offset += written;
        this.bytes += written;
      }
    } catch (error) {
      throw new Error(`${String(error)}; partial file=${JSON.stringify(this.path)} (${this.bytes} bytes)`);
    }
  }

  close(): void {
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

/** Scan each incoming chunk once; retained partial-line storage does not grow with the input. */
export async function readMonitorOutput(
  stream: ReadableStream<Uint8Array>,
  line: (text: string) => unknown,
  notice: (text: string) => unknown,
  stopped: () => boolean,
): Promise<void> {
  const buffer = Buffer.alloc(LINE_MAX_BYTES);
  const initialDecoder = new TextDecoder();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let used = 0;
  let first = true;
  let spill: MonitorOutputFile | undefined;
  try {
    for await (const chunk of stream) {
      if (stopped()) return;
      let start = 0;
      while (start < chunk.byteLength) {
        if (stopped()) return;
        const lf = chunk.indexOf(10, start);
        const end = lf < 0 ? chunk.byteLength : lf;
        const part = chunk.subarray(start, end);
        if (!spill && used + part.byteLength > LINE_MAX_BYTES) {
          spill = new MonitorOutputFile();
          spill.write(buffer.subarray(0, used));
          used = 0;
          await notice(
            `line exceeds ${LINE_MAX_BYTES} bytes; filter not evaluated; raw output file=${JSON.stringify(spill.path)} (still writing)`,
          );
        }
        if (spill) {
          spill.write(part);
          if (lf >= 0) {
            spill.write(chunk.subarray(lf, lf + 1));
            spill.close();
            await notice(`oversized line saved: ${spill.bytes} bytes; file=${JSON.stringify(spill.path)}`);
            spill = undefined;
          }
        } else {
          buffer.set(part, used);
          used += part.byteLength;
          if (lf >= 0) {
            // Only the stream's initial BOM is stripped, as with one streaming TextDecoder.
            await line((first ? initialDecoder : decoder).decode(buffer.subarray(0, used)).replace(/\r$/, ""));
            used = 0;
          }
        }
        if (lf >= 0) first = false;
        start = lf < 0 ? chunk.byteLength : lf + 1;
      }
    }
    if (stopped()) return;
    if (spill) {
      spill.close();
      await notice(`oversized line saved: ${spill.bytes} bytes; file=${JSON.stringify(spill.path)}`);
    } else if (used) {
      const tail = (first ? initialDecoder : decoder).decode(buffer.subarray(0, used));
      if (tail) await line(tail);
    }
  } catch (error) {
    const saved = spill ? `; partial file=${JSON.stringify(spill.path)} (${spill.bytes} bytes)` : "";
    throw new Error(`${String(error)}${saved}`);
  } finally {
    spill?.close();
  }
}

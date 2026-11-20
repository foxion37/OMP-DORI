import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { MonitorOutputFile, readMonitorOutput } from "../monitor-output";

const paths = new Set<string>();
afterEach(() => {
  for (const path of paths) fs.rmSync(dirname(path), { recursive: true, force: true });
  paths.clear();
});
const remember = (text: string) => {
  const path = /file=("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
  if (path) paths.add(JSON.parse(path) as string);
};

test("keeps byte boundaries and normal lines between multiple spills in one chunk", async () => {
  const input = Buffer.from(`${"a".repeat(65536)}\n${"b".repeat(65537)}\nnormal\n${"c".repeat(65538)}`);
  const lines: string[] = [];
  await readMonitorOutput(
    new ReadableStream({
      start(c) {
        c.enqueue(input);
        c.close();
      },
    }),
    (s) => lines.push(s),
    remember,
    () => false,
  );
  expect(lines).toEqual(["a".repeat(65536), "normal"]);
  expect([...paths].map((p) => fs.readFileSync(p, "utf8"))).toEqual([`${"b".repeat(65537)}\n`, "c".repeat(65538)]);
});

test("matches streaming decoding across byte splits, invalid UTF-8 and BOM-only EOF", async () => {
  for (const input of [
    Buffer.from([239, 187, 191]),
    Buffer.from([239, 187, 191, 97, 13, 10, 239, 187, 191, 98, 10, 195, 10, 240, 159]),
  ]) {
    const expected = new TextDecoder().decode(input).split("\n");
    const tail = expected.pop()!;
    const normalized = expected.map((s) => s.replace(/\r$/, ""));
    if (tail) normalized.push(tail);
    const lines: string[] = [];
    await readMonitorOutput(
      new ReadableStream({
        start(c) {
          for (const byte of input) c.enqueue(Uint8Array.of(byte));
          c.close();
        },
      }),
      (s) => lines.push(s),
      remember,
      () => false,
    );
    expect(lines).toEqual(normalized);
  }
});

test("finishes short writes and closes the descriptor after a later stream error", async () => {
  const original = fs.writeSync;
  const short = spyOn(fs, "writeSync").mockImplementation(
    (
      fd: number,
      data: NodeJS.ArrayBufferView | string,
      offset?: number | null,
      length?: number | BufferEncoding | null,
      position?: number | null,
    ) => {
      if (typeof data === "string") return original(fd, data, offset, typeof length === "string" ? length : undefined);
      return original(
        fd,
        data,
        offset,
        Math.min(typeof length === "number" ? length : data.byteLength - (offset ?? 0), 1024),
        position,
      );
    },
  );
  const closed = spyOn(fs, "closeSync");
  try {
    let pulled = false;
    await expect(
      readMonitorOutput(
        new ReadableStream({
          pull(c) {
            if (pulled) c.error(new Error("fixture read failure"));
            else {
              pulled = true;
              c.enqueue(Buffer.alloc(65537, 120));
            }
          },
        }),
        () => {},
        remember,
        () => false,
      ),
    ).rejects.toThrow("fixture read failure");
    expect(paths.size).toBe(1);
    expect(fs.readFileSync([...paths][0]!)).toEqual(Buffer.alloc(65537, 120));
    expect(closed).toHaveBeenCalled();
    expect(() => fs.fstatSync(closed.mock.calls[0]![0])).toThrow();
  } finally {
    short.mockRestore();
    closed.mockRestore();
  }
});

test("a failed file open removes the newly created empty directory", () => {
  const make = spyOn(fs, "mkdtempSync");
  const failure = spyOn(fs, "openSync").mockImplementation(() => {
    throw new Error("fixture open failure");
  });
  try {
    expect(() => new MonitorOutputFile()).toThrow("fixture open failure");
    const directory = make.mock.results[0]?.value;
    if (typeof directory !== "string") throw new Error("expected a temporary directory path");
    expect(fs.existsSync(directory)).toBe(false);
  } finally {
    failure.mockRestore();
    make.mockRestore();
  }
});

test("a failed write identifies its retained partial file", () => {
  const output = new MonitorOutputFile();
  paths.add(output.path);
  output.write(Buffer.from("prefix"));
  const failure = spyOn(fs, "writeSync").mockImplementation(() => {
    throw new Error("fixture ENOSPC");
  });
  try {
    expect(() => output.write(Buffer.from("unwritten"))).toThrow(
      `partial file=${JSON.stringify(output.path)} (6 bytes)`,
    );
  } finally {
    failure.mockRestore();
    output.close();
  }
  expect(fs.readFileSync(output.path, "utf8")).toBe("prefix");
});

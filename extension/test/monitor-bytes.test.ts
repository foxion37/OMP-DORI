import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { Monitors } from "../monitor";
import { until } from "./fake-pi";

const messages: string[] = [];
const monitors = new Monitors(
  (text) => messages.push(text),
  () => "s1",
  10,
);
const files = () => [
  ...new Set(
    messages.flatMap((text) => [...text.matchAll(/file=("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string)),
  ),
];
afterEach(() => {
  monitors.stopAll();
  for (const path of files()) fs.rmSync(dirname(path), { recursive: true, force: true });
  messages.length = 0;
});
// These integration tests read real child pipes; fake clocks cannot drive their I/O or lifetime.
const start = (code: string, filter = ".", name = "bytes") =>
  monitors.start(name, [process.execPath, "-e", code], filter, "/", "s1");
const exited = () => until(() => messages.join("\n").includes("monitor exited"));
const posix = test.skipIf(process.platform === "win32");

test("preserves split UTF-8, CRLF, empty lines, and an unterminated final line", async () => {
  start(
    'const b=Buffer.from("\\uFEFFhit \\u00e9\\u{1f642}\\r\\n\\n\\uFEFFhit tail\\r"); for(const v of b){process.stdout.write(Buffer.from([v]));await Bun.sleep(1)}',
    "^|hit",
  );
  await exited();
  expect(
    messages
      .join("\n")
      .split("\n")
      .filter((s) => !s.includes("monitor exited")),
  ).toEqual(["[bytes] hit \u00e9\u{1f642}", "[bytes] ", "[bytes] \uFEFFhit tail\r"]);
});

// POSIX-only: the spool file and directory must carry 0o600 and 0o700 mode bits.
posix("spools oversized stdout/stderr losslessly even with a nonmatching filter", async () => {
  start(
    'process.stdout.write("x".repeat(8*1024*1024)+"\\r\\nkeep\\n");process.stderr.write("y".repeat(65537))',
    "^keep$",
  );
  await exited();
  expect(messages.join("\n")).toContain("filter not evaluated");
  expect(messages.join("\n")).toContain("[bytes] keep");
  expect(files()).toHaveLength(2);
  const raw = files().map((path) => fs.readFileSync(path));
  expect(raw.some((b) => b.equals(Buffer.from(`${"x".repeat(8 * 1024 * 1024)}\r\n`)))).toBe(true);
  expect(raw.some((b) => b.equals(Buffer.from("y".repeat(65537))))).toBe(true);
  for (const path of files()) {
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(path)).mode & 0o777).toBe(0o700);
  }
  expect(messages.every((s) => Buffer.byteLength(s) <= 65536)).toBe(true);
});

test("caps raw lines and rendered batches including names and separators", async () => {
  start(
    'process.stdout.write("x".repeat(65536)+"\\n");for(let i=0;i<100;i++)process.stdout.write("\u00e9".repeat(2000)+"\\n")',
  );
  await exited();
  expect(messages.every((s) => Buffer.byteLength(s) <= 65536)).toBe(true);
  expect(
    messages
      .join("\n")
      .split("\n")
      .filter((s) => s === `[bytes] ${"\u00e9".repeat(2000)}`),
  ).toHaveLength(100);
  // The line is within its raw cap, but its rendered name prefix exceeds one batch.
  expect(files()).toHaveLength(1);
  expect(fs.readFileSync(files()[0]!, "utf8")).toBe(`[bytes] ${"x".repeat(65536)}`);
});

test("reports and stops on a spool failure instead of dropping output or buffering forever", async () => {
  const failure = spyOn(fs, "mkdtempSync").mockImplementation(() => {
    throw new Error("fixture storage unavailable");
  });
  try {
    start('process.stdout.write("x".repeat(65537));setInterval(()=>{},1000)');
    await until(() => messages.join("\n").includes("output failed"));
    expect(messages.join("\n")).toContain("fixture storage unavailable");
    expect(messages.join("\n")).toContain("may be incomplete");
    expect(monitors.list()).toEqual([]);
  } finally {
    failure.mockRestore();
  }
});

test("announces an unterminated spill before exit and retains it across stop", async () => {
  const { pid } = start('process.stdout.write("z".repeat(131072));setInterval(()=>{},1000)', "^NO_MATCH$");
  await until(() => messages.join("\n").includes("still writing"));
  const path = files()[0]!;
  monitors.stopAll();
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  expect(fs.readFileSync(path).length).toBeGreaterThan(65536);
  expect(messages.join("\n")).not.toContain("monitor exited");
});

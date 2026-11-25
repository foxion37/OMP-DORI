import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cataly-schedule-cli-"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function invoke(args: string[], timeout = 10_000) {
  const child = Bun.spawnSync([process.execPath, "--no-env-file", cli, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      PATH: process.env["PATH"],
      CATALY_CONFIG: join(dir, "config.json"),
      CATALY_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
    timeout,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}
function due() {
  const path = join(dir, "state/schedule.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  // Controlled durable clock input; the CLI, child, files and current clock are real.
  document.jobs[0].nextAt = Date.now() - 1000;
  writeFileSync(path, JSON.stringify(document));
}

const cwdCases =
  process.platform === "win32"
    ? [undefined, "job with spaces"]
    : [undefined, "job with spaces", "job ", " job", " ", "\tjob\t"];
test.each(cwdCases)("schedule add/list and one-shot scheduler preserve argv and cwd without replay: %j", (path) => {
  const cwd = resolve(dir, path ?? ".");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(resolve(dir, (path ?? ".").trim()), { recursive: true });
  const literal = "two words; $(not-executed)";
  const argv = [
    process.execPath,
    "-e",
    "require('node:fs').appendFileSync('runs', 'x'); console.log(process.argv.at(-1)); console.error('stderr')",
    "--",
    literal,
  ];
  const added = invoke([
    "schedule",
    "add",
    "board",
    "--cron",
    "*/15 * * * *",
    "--tz",
    "Asia/Seoul",
    ...(path === undefined ? [] : ["--cwd", path]),
    "--deliver",
    "log",
    "--",
    ...argv,
  ]);
  expect(added.code).toBe(0);
  const listed = invoke(["schedule", "list"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out).jobs[0]).toMatchObject({
    name: "board",
    cron: "*/15 * * * *",
    tz: "Asia/Seoul",
    deliver: "log",
    argv,
    missed: 0,
  });
  due();
  const ran = invoke(["scheduler", "--loop", "0"]);
  expect(ran).toEqual({ code: 0, out: "", err: "" });
  const job = JSON.parse(invoke(["schedule", "list"]).out).jobs[0];
  expect(job.last).toMatchObject({ status: "exited", code: 0, delivery: "logged" });
  expect(readFileSync(job.last.output, "utf8")).toContain(literal);
  expect(readFileSync(job.last.output, "utf8")).toContain("stderr");
  expect(invoke(["scheduler", "--loop", "0"]).code).toBe(0);
  // A native child can report an equivalent short Win32 or /private macOS pathname.
  const expectedDirectory = statSync(cwd, { bigint: true });
  const storedDirectory = statSync(job.cwd, { bigint: true });
  expect(expectedDirectory.ino).not.toBe(0n);
  expect([storedDirectory.dev, storedDirectory.ino]).toEqual([expectedDirectory.dev, expectedDirectory.ino]);
  expect(readFileSync(join(cwd, "runs"), "utf8")).toBe("x");
});

test("scheduler wake emits one output receipt without posting externally", () => {
  expect(
    invoke([
      "schedule",
      "add",
      "wake",
      "--cron",
      "* * * * *",
      "--tz",
      "UTC",
      "--",
      process.execPath,
      "-e",
      "console.log('ready')",
    ]).code,
  ).toBe(0);
  due();
  const ran = invoke(["scheduler", "--loop", "0"]);
  expect(ran.code).toBe(0);
  expect(ran.out).toContain("SCHEDULE_WAKE ");
  expect(ran.out).toContain("ready");
  expect(JSON.parse(invoke(["schedule", "list"]).out).jobs[0].last.delivery).toBe("wake-emitted");
});

test.each([{ names: [] }, { names: ["one", "extra"] }])(
  "add requires exactly one name before the command separator: %j",
  ({ names }) => {
    const result = invoke(["schedule", "add", ...names, "--cron", "* * * * *", "--tz", "UTC", "--", "echo", "ready"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("exactly one name before --");
    expect(existsSync(join(dir, "state/schedule.json"))).toBe(false);
  },
);

test.each(["1", "5"])("scheduler rejects a poll period that can silently skip cron work: %s", (minutes) => {
  const result = invoke(["scheduler", "--loop", minutes], 500);
  expect(result.code).toBe(1);
  expect(result.err).toContain("less than 1 minute");
  expect(existsSync(join(dir, "state/scheduler.lock"))).toBe(false);
});

test("scheduler wakes at the next occurrence before its longer poll interval", async () => {
  expect(
    invoke([
      "schedule",
      "add",
      "soon",
      "--cron",
      "* * * * *",
      "--tz",
      "UTC",
      "--",
      process.execPath,
      "-e",
      "console.log(123)",
    ]).code,
  ).toBe(0);
  const path = join(dir, "state/schedule.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.jobs[0].nextAt = Date.now() + 750;
  writeFileSync(path, JSON.stringify(document));
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "scheduler", "--loop", "0.9"], {
    cwd: dir,
    env: {
      HOME: dir,
      PATH: process.env["PATH"],
      CATALY_CONFIG: join(dir, "config.json"),
      CATALY_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2000,
    killSignal: "SIGTERM",
  });
  const reader = child.stdout.getReader();
  try {
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain("SCHEDULE_WAKE ");
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
});

test.each([
  { args: ["list", "extra"] },
  { args: ["pause", "job", "extra"] },
  { args: ["resume", "job", "extra"] },
  { args: ["remove", "job", "extra"] },
  { args: ["adopt", "one", "extra", "--systemd", "cataly-htmlview.service"] },
])("schedule rejects unused positional arguments before effects: %j", ({ args }) => {
  const result = invoke(["schedule", ...args]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("positional arguments");
  expect(existsSync(join(dir, "state/schedule.json"))).toBe(false);
});

test("invalid cron and timezone are rejected before state or child creation", () => {
  const badCron = invoke([
    "schedule",
    "add",
    "bad",
    "--cron",
    "not cron",
    "--tz",
    "UTC",
    "--",
    process.execPath,
    "-e",
    "throw 1",
  ]);
  expect(badCron.code).toBe(1);
  expect(badCron.err).toContain("cron");
  const badZone = invoke([
    "schedule",
    "add",
    "bad",
    "--cron",
    "* * * * *",
    "--tz",
    "Not/A_Zone",
    "--",
    process.execPath,
    "-e",
    "throw 1",
  ]);
  expect(badZone.code).toBe(1);
  expect(badZone.err).toContain("timezone");
  expect(existsSync(join(dir, "state/schedule.json"))).toBe(false);
});

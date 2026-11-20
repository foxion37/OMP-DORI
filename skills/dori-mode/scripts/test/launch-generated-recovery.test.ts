import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { withState } from "./fakes.ts";
import { queueFixture, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
let brief: string;
beforeEach(async () => {
  f = await queueFixture();
  const templates = join(f.state.dir, "templates");
  mkdirSync(templates);
  writeFileSync(join(templates, "task.md"), "Preserve the rendered instructions.\n");
  brief = join(f.state.dir, "briefs", `${f.input.key}.md`);
});
afterEach(() => f.state.done());

const withCreateReply = (reply: Runner): FlowDeps => ({
  ...f.deps,
  run: async (argv, options) =>
    argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create" ? reply(argv, options) : f.deps.run(argv, options),
});
const noServer = { code: 1, out: "", err: '{"error":{"code":"server_not_running"}}' };

const retainedBrief = (): string => {
  const attempts = `${brief}.attempts`;
  const [attempt, ...others] = readdirSync(attempts);
  if (!attempt || others.length) throw new Error(`expected one retained attempt in ${attempts}`);
  return join(attempts, attempt, "brief.md");
};

const rlimit = test.skipIf(process.platform === "win32" || !existsSync("/bin/sh"));
rlimit.each([0, 1])("a staging write over a %i-block file limit does not hold a same-key launch", async (blocks) => {
  const module = new URL("../src/launch-generated.ts", import.meta.url).href;
  const script = `import { stageGeneratedBrief } from ${JSON.stringify(module)};
try {
  stageGeneratedBrief(${JSON.stringify(brief)}, "oversized brief".repeat(2048));
  process.exit(2);
} catch (error) {
  console.log(error.code);
}`;
  // RLIMIT_FSIZE applies only to this child; ignoring SIGXFSZ makes the real write report EFBIG.
  const child = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'trap "" XFSZ && ulimit -f "$1" && shift && exec "$@"',
      "dori-brief-fixture",
      String(blocks),
      process.execPath,
      "-e",
      script,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ out, err, code }).toEqual({ out: "EFBIG\n", err: "", code: 0 });
  expect(existsSync(brief)).toBe(false);
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  const launched = await launchLane(f.deps, { ...f.input, brief, template: "task" });
  expect(launched.startup).toContain("STARTUP_OK");
  expect(f.creates()).toBe(1);
});

test("a known terminal refusal releases the generated brief and permits a same-key retry", async () => {
  const input = { ...f.input, brief, template: "task" };
  await expect(
    launchLane(
      withCreateReply(async () => noServer),
      input,
    ),
  ).rejects.toThrow("session create failed");
  expect(existsSync(brief)).toBe(false);
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  expect(await f.deps.registry.read(input.key)).toBeNull();

  expect((await launchLane(f.deps, input)).startup).toContain("STARTUP_OK");
  expect(readFileSync(brief, "utf8")).toContain("Preserve the rendered instructions.");
  expect(f.creates()).toBe(1);
});

test("a CLI failure to spawn the runtime releases the generated brief", async () => {
  const config = join(f.state.dir, "config.json");
  writeFileSync(config, JSON.stringify(f.deps.config));
  const cli = join(import.meta.dir, "../src/cli.ts");
  const args = ["launch", f.input.key, "--title", "Task", "--template", "task", "--done", f.input.done];
  // PATH is isolated, so no real runtime can start and process creation itself fails.
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: f.state.dir,
    env: {
      PATH: f.state.dir,
      HOME: f.state.dir,
      DORI_CONFIG: config,
      ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"], USERPROFILE: f.state.dir } : {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  expect(code).toBe(1);
  expect(err).toContain("session create failed");
  expect(existsSync(brief)).toBe(false);
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test.each([
  { outcome: "a lost connection", response: { code: 1, out: "", err: "socket closed" } },
  { outcome: "an incomplete success reply", response: { code: 0, out: '{"result":{}}', err: "" } },
  { outcome: "a child exiting 127", response: { code: 127, out: "", err: "child exited" } },
])("$outcome after terminal creation retains the generated brief and blocks retry", async ({ response }) => {
  const input = { ...f.input, brief, template: "task" };
  const deps = withCreateReply(async (argv, options) => {
    await f.deps.run(argv, options);
    return response;
  });

  await expect(launchLane(deps, input)).rejects.toThrow("generated brief retained at");
  const path = retainedBrief();
  const contents = readFileSync(path, "utf8");
  expect(contents).toContain("Preserve the rendered instructions.");
  expect(await deps.registry.read(input.key)).toBeNull();
  await expect(launchLane(f.deps, input)).rejects.toThrow("generated brief not writable");
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect(f.creates()).toBe(1);
});

test("a known terminal refusal leaves an independently created public brief untouched", async () => {
  const input = { ...f.input, brief, template: "task" };
  const deps = withCreateReply(async () => {
    writeFileSync(brief, "Independent output", { flag: "wx" });
    return noServer;
  });

  await expect(launchLane(deps, input)).rejects.toThrow("session create failed");
  expect(readFileSync(brief, "utf8")).toBe("Independent output");
  expect(readdirSync(`${brief}.attempts`)).toEqual([]);
  expect(await deps.registry.read(input.key)).toBeNull();
});

const fileSymlinksAvailable = (() => {
  if (process.platform !== "win32") return true;
  const state = withState();
  try {
    const target = join(state.dir, "target");
    writeFileSync(target, "");
    symlinkSync(target, join(state.dir, "link"), "file");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  } finally {
    state.done();
  }
})();

test.skipIf(!fileSymlinksAvailable)(
  "a link inserted during terminal creation is not overwritten or removed",
  async () => {
    const original = readFileSync(f.input.brief, "utf8");
    const input = { ...f.input, brief, template: "task" };
    const deps = withCreateReply(async (argv, options) => {
      symlinkSync(f.input.brief, brief);
      return f.deps.run(argv, options);
    });

    await expect(launchLane(deps, input)).rejects.toThrow("generated brief not published");
    expect(lstatSync(brief).isSymbolicLink()).toBe(true);
    expect(readFileSync(f.input.brief, "utf8")).toBe(original);
    expect(readFileSync(retainedBrief(), "utf8")).toContain("Preserve the rendered instructions.");
    expect(await deps.registry.read(input.key)).toBeNull();
    expect(f.world.calls).toContainEqual(["herdr", "tab", "close", "w1:t9"]);
  },
);

test.each([
  { label: "unstructured usage exit", code: 2, err: "child exited without a structured reply", rejected: false },
  { label: "unstructured invalid-params exit", code: 6, err: "lost reply", rejected: false },
  { label: "structured invalid-params reply", code: 6, err: '{"error":{"kind":"invalid_params"}}', rejected: true },
])("an hc $label controls brief retention and retry", async ({ code, err, rejected }) => {
  const input = { ...f.input, brief, template: "task" };
  let runs = 0;
  const deps: FlowDeps = {
    ...f.deps,
    config: { ...f.deps.config, runtime: "hc" },
    run: async (argv) => {
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "ls")
        return { code: 0, out: '{"terminals":[]}', err: "" };
      if (argv[0] === "hc" && argv[1] === "--json" && argv[2] === "run") {
        runs++;
        return { code, out: "", err };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    },
  };

  if (rejected) {
    await expect(launchLane(deps, input)).rejects.toThrow("invalid_params");
    expect(readdirSync(`${brief}.attempts`)).toEqual([]);
    await expect(launchLane(deps, input)).rejects.toThrow("invalid_params");
    expect(runs).toBe(2);
  } else {
    await expect(launchLane(deps, input)).rejects.toThrow("generated brief retained at");
    expect(readFileSync(retainedBrief(), "utf8")).toContain("Preserve the rendered instructions.");
    await expect(launchLane(deps, input)).rejects.toThrow("inspect the prior attempt");
    expect(runs).toBe(1);
  }
  expect(await deps.registry.read(input.key)).toBeNull();
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_START } from "../src/launch-footer.ts";
import { renderTemplate } from "../src/launch-template.ts";
import { launchLane, prepareLaunch } from "../src/launch.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { Registry } from "../src/registry.ts";
import { queueFixture, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
let config: string;
let templates: string;
beforeEach(async () => {
  f = await queueFixture();
  config = join(f.state.dir, "config.json");
  templates = join(f.state.dir, "templates");
  mkdirSync(templates);
  writeFileSync(config, JSON.stringify(f.deps.config));
});
afterEach(() => f.state.done());
const template = (name: string, text: string) => writeFileSync(join(templates, name + ".md"), text);
const cliWith =
  (preload?: string) =>
  async (...args: string[]) => {
    const p = Bun.spawn(
      [process.execPath, ...(preload ? ["--preload", preload] : []), join(import.meta.dir, "../src/cli.ts"), ...args],
      {
        cwd: f.state.dir,
        env: { HOME: f.state.dir, PATH: join(f.state.dir, "bin"), DORI_CONFIG: config },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = new Response(p.stdout).text();
    const err = new Response(p.stderr).text();
    return { out: await out, err: await err, code: await p.exited };
  };
const cli = cliWith();

test("includes and variables render literally without evaluating shell or replacement syntax", () => {
  template("common", "Check {{target}}.");
  template("deploy", "{{>common}}\nUse {{branch}} and {{branch}}.");
  expect(renderTemplate("deploy", { target: "beta", branch: "$(touch nope) $& {{untouched}}" }, config)).toBe(
    "Check beta.\nUse $(touch nope) $& {{untouched}} and $(touch nope) $& {{untouched}}.",
  );
  expect(existsSync(join(f.state.dir, "nope"))).toBe(false);
});

test("missing variables, malformed expressions and unavailable templates are explicit refusals", () => {
  template("needs", "{{branch}}");
  expect(() => renderTemplate("needs", {}, config)).toThrow("missing template variable");
  template("bad", "{{branch");
  expect(() => renderTemplate("bad", {}, config)).toThrow("malformed");
  expect(() => renderTemplate("absent", {}, config)).toThrow("template unavailable");
  expect(() => renderTemplate("../escape", {}, config)).toThrow("invalid template name");
});

test("include cycles are rejected by physical file identity", () => {
  template("a", "{{>b}}");
  template("b", "{{>a}}");
  expect(() => renderTemplate("a", {}, config)).toThrow("cycle");
  template("self", "{{>alias}}");
  symlinkSync(join(templates, "self.md"), join(templates, "alias.md"));
  expect(() => renderTemplate("self", {}, config)).toThrow("cycle");
});

test("a template symlink to an existing file outside the template directory is rejected", () => {
  symlinkSync(f.input.brief, join(templates, "outside.md"));
  expect(() => renderTemplate("outside", {}, config)).toThrow("template escapes its directory: outside");
});

test("template dry-run preserves literal footer-shaped text without filesystem or runtime side effects", async () => {
  const quoted = "<!-- dori launch: footer start -->\nQuoted prior footer\n<!-- dori launch: footer end --> \t\n";
  template("deploy", "Deploy {{branch}} to {{target}}.\r\n{{quoted}}");
  const result = await cli(
    "launch",
    "from-template",
    "--title",
    "Template run",
    "--template",
    "deploy",
    "--set",
    "branch=main",
    "--set",
    "target=beta",
    "--set",
    `quoted=${quoted}`,
    "--done",
    "closed acme/app#3",
    "--dry-run",
  );
  expect(result.code).toBe(0);
  const rendered = `Deploy main to beta.\r\n${quoted}`;
  expect(result.out).toStartWith(`${BRIEF_START}\n${rendered}\n\n<!-- dori launch: footer start -->`);
  expect(existsSync(join(f.state.dir, "briefs"))).toBe(false);
  expect(new LaunchQueue(f.state.dir).scan().entries).toEqual([]);
  expect(await f.deps.registry.read("from-template")).toBeNull();
});

test("direct template launch writes literal trailing text before the normal startup footer", async () => {
  expect((await prepareLaunch(f.deps, f.input)).preamble).toContain("Implement the recorded request");
  template("task", "Implement {{change}}.  \t\r\n");
  const brief = join(f.state.dir, "briefs", "rendered.md");
  const started = await launchLane(f.deps, {
    ...f.input,
    brief,
    template: "task",
    variables: { change: "the requested feature" },
  });
  expect(started.startup).toContain("STARTUP_OK");
  expect(await Bun.file(brief).text()).toStartWith(
    `${BRIEF_START}\nImplement the requested feature.  \t\r\n\n\n<!-- dori launch: footer start -->`,
  );
  expect(f.creates()).toBe(1);
});

test.each(["file", "symlink"])("template launch leaves an existing generated output %s untouched", async (kind) => {
  template("task", "Rendered content must not overwrite an existing file.");
  const dir = join(f.state.dir, "briefs");
  mkdirSync(dir);
  const brief = join(dir, `${f.input.key}.md`);
  const target = kind === "symlink" ? f.input.brief : brief;
  if (kind === "symlink") {
    symlinkSync(target, brief);
  } else {
    writeFileSync(target, "Prior generated output");
  }
  const original = readFileSync(target, "utf8");

  await expect(launchLane(f.deps, { ...f.input, brief, template: "task" })).rejects.toThrow(
    "generated brief not writable",
  );

  expect(readFileSync(brief, "utf8")).toBe(original);
  expect(lstatSync(brief).isSymbolicLink()).toBe(kind === "symlink");
  expect(f.creates()).toBe(0);
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test.each(["direct", "queued"])("a %s CLI lane reads its generated brief from a different cwd", async (kind) => {
  const herdr = join(f.state.dir, "herdr.ts");
  const preload = join(f.state.dir, "herdr-preload.ts");
  const repo = join(f.state.dir, "agent-cwd");
  const state = join(f.state.dir, "state");
  const recordedCwd = join(f.state.dir, "pane-cwd");
  const observed = join(f.state.dir, "agent-readback");
  mkdirSync(repo);
  writeFileSync(
    herdr,
    `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "tab" && args[1] === "create") {
  writeFileSync(${JSON.stringify(recordedCwd)}, args[args.indexOf("--cwd") + 1]);
  console.log(JSON.stringify({ result: { root_pane: { pane_id: "w:p1" }, tab_id: "w:t1" } }));
} else if (args[0] === "pane" && args[1] === "list") {
  console.log(JSON.stringify({ result: { panes: [] } }));
} else if (args[0] === "pane" && args[1] === "run") {
  const brief = /Read and execute the lane brief at (.+?) in full\\./.exec(args[3])?.[1];
  if (!brief) throw new Error("missing brief in the agent command");
  process.chdir(readFileSync(${JSON.stringify(recordedCwd)}, "utf8"));
  writeFileSync(${JSON.stringify(observed)}, readFileSync(brief));
  // The fixture has read the brief. Stop at the runtime boundary rather than launch a real agent.
  process.exit(23);
} else {
  process.exit(1);
}
`,
  );
  // Use Bun to run the fixture instead of relying on a PATH shebang, which Windows does not execute.
  writeFileSync(
    preload,
    `const spawn = Bun.spawn.bind(Bun);
Object.defineProperty(Bun, "spawn", {
  value: (argv, options) => spawn(
    Array.isArray(argv) && argv[0] === "herdr"
      ? [process.execPath, ${JSON.stringify(herdr)}, ...argv.slice(1)]
      : argv,
    options,
  ),
});
`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      ...f.deps.config,
      stateDir: "state",
      defaultCwd: kind === "direct" ? repo : f.state.dir,
      guard: { ...f.deps.config.guard, memFreeMinPct: 0, diskFreeMinGb: 0 },
    }),
  );
  const registry = new Registry(state);
  await registry.write({ ...f.prior, done: `file ${JSON.stringify(f.input.brief)}` });
  template("task", "Read this from the agent working directory.");
  const args = ["launch", f.input.key, "--title", "Task", "--template", "task", "--done", f.input.done];

  const invoke = cliWith(preload);
  if (kind === "queued")
    expect(await invoke(...args, "--after", f.prior.key, "--cwd", repo)).toMatchObject({ code: 0 });
  const result = kind === "queued" ? await invoke("queue", "start", f.input.key) : await invoke(...args);

  const lane = await registry.read(f.input.key);
  if (!lane) throw new Error(`generated brief did not reach startup: ${result.err || result.out}`);
  expect(result.code).toBe(3);
  expect(result.out).toContain("STARTUP_ERROR");
  expect(readFileSync(recordedCwd, "utf8")).toBe(kind === "queued" ? realpathSync.native(repo) : repo);
  expect(readFileSync(observed, "utf8")).toBe(readFileSync(lane.brief, "utf8"));
  expect(readFileSync(observed, "utf8")).toContain("Read this from the agent working directory.");
});

test("real CLI queues a rendered snapshot, lists it after restart, and explicitly cancels it", async () => {
  template("task", "Implement {{change}}.");
  const queued = await cli(
    "launch",
    f.input.key,
    "--title",
    "Queued template",
    "--template",
    "task",
    "--set",
    "change=the requested feature",
    "--done",
    f.input.done,
    "--after",
    f.prior.key,
  );
  expect(queued.code).toBe(0);
  expect(queued.out).toContain("QUEUED");
  template("task", "Changed template.");
  const listed = await cli("queue", "list");
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)[0].briefText).toContain("Implement the requested feature.");
  expect((await cli("queue", "cancel", f.input.key)).code).toBe(0);
  expect(new LaunchQueue(f.state.dir).read(f.input.key)?.status).toBe("cancelled");
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test("real CLI refuses ambiguous template input and missing values before effects", async () => {
  template("task", "{{required}}");
  const base = ["launch", f.input.key, "--title", "Task", "--done", f.input.done];
  expect((await cli(...base, "--brief", f.input.brief, "--template", "task")).err).toContain(
    "choose --brief or --template",
  );
  expect((await cli(...base, "--template", "task", "--dry-run")).err).toContain("missing template variable");
  expect((await cli(...base, "--template", "task", "--set", "broken")).err).toContain("name=value");
  expect(existsSync(join(f.state.dir, "briefs"))).toBe(false);
});

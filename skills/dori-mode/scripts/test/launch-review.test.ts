import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { launchLane } from "../src/launch.ts";
import { BRIEF_START } from "../src/launch-footer.ts";
import { cancelQueued, enqueueLaunch, queueTick, startQueued } from "../src/launch-queue.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { pauseLane } from "../src/pause.ts";
import { queueFixture, roomy, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
beforeEach(async () => {
  f = await queueFixture();
});
afterEach(() => f.state.done());
const store = () => new LaunchQueue(f.state.dir);

const cli = async (...args: string[]) => {
  const config = join(f.state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ ...f.deps.config, runtime: "herdr" }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: f.state.dir, HOME: f.state.dir, DORI_CONFIG: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
};

test.each(["start", "cancel"])("queue %s rejects --dry-run without live checks or changes", async (action) => {
  const marker = join(f.state.dir, "done-command-ran");
  const command = [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "called")`];
  await f.deps.registry.write({ ...f.prior, done: `command ${JSON.stringify(command)}` });
  const entry = await enqueueLaunch(f.deps, f.input, [f.prior.key]);

  const result = await cli("queue", action, f.input.key, "--dry-run");

  expect(result).toMatchObject({ code: 1, out: "", err: expect.stringContaining("--dry-run") });
  expect(existsSync(marker)).toBe(false);
  expect(store().read(f.input.key)).toEqual(entry);
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test.each(["default", "explicit", "legacy"])("queued %s cwd controls disk admission and launch", async (kind) => {
  const enqueuedDefault = join(f.state.dir, "original");
  const explicit = join(f.state.dir, "override");
  const startDefault = join(f.state.dir, "new-default");
  for (const dir of [enqueuedDefault, explicit, startDefault]) mkdirSync(dir);
  const enqueued = kind === "explicit" ? explicit : enqueuedDefault;
  const expected = kind === "legacy" ? startDefault : realpathSync.native(enqueued);
  const entry = await enqueueLaunch(
    { ...f.deps, config: { ...f.deps.config, defaultCwd: relative(process.cwd(), enqueuedDefault) } },
    kind === "explicit" ? { ...f.input, cwd: relative(process.cwd(), explicit) } : f.input,
    [f.prior.key],
  );
  if (kind === "legacy") {
    const { cwd: _cwd, ...input } = entry.input;
    store().write({ ...entry, input });
  } else {
    expect(store().read(f.input.key)?.input.cwd).toBe(expected);
  }
  const deps = {
    ...f.deps,
    config: {
      ...f.deps.config,
      defaultCwd: startDefault,
      guard: { ...f.deps.config.guard, memFreeMinPct: 0, diskFreeMinGb: 1 },
    },
    run: async (...args: Parameters<typeof f.deps.run>) =>
      args[0][0] === "df"
        ? { code: 0, out: `fixture 3000000 0 ${args[0][2] === expected ? 3000000 : 0}`, err: "" }
        : f.deps.run(...args),
  };

  expect((await startQueued(deps, f.input.key)).code).toBe(0);
  const lane = await deps.registry.read(f.input.key);
  if (!lane) throw new Error("queued lane did not register");
  const create = f.world.calls.find((argv) => argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create");
  expect(create?.[5]).toBe("--cwd");
  expect(create?.[6]).toBe(expected);
  expect(lane.cwd).toBe(expected);
  expect(readFileSync(lane.brief, "utf8")).toContain(`Recorded working directory: ${JSON.stringify(expected)}`);
});

test("pause remains usable while a launched agent is awaiting its startup check", async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deps = {
    ...f.deps,
    clock: {
      now: f.deps.clock.now,
      sleep: async (ms: number) => {
        if (ms === 20_000) {
          waiting.resolve();
          await release.promise;
        }
        await f.deps.clock.sleep(ms);
      },
    },
  };
  const launched = launchLane(deps, f.input);
  try {
    await waiting.promise;
    f.world.panes = f.world.panes.map((p) => ({ ...p, agent: "omo", agent_status: "idle" }));
    f.world.screens = ["\u276f ", "Goal paused\n\u276f "];
    const lane = await f.deps.registry.read(f.input.key);
    if (!lane) throw new Error("launch did not register its lane before startup verification");
    const paused = await pauseLane(f.deps, lane, "owner interrupted startup");
    expect(paused.code).toBe(0);
    expect((await f.deps.registry.read(f.input.key))?.status).toBe("paused");
    expect(f.world.calls.some((a) => a.includes("/goal pause"))).toBe(true);
  } finally {
    release.resolve();
    await launched;
  }
  expect((await f.deps.registry.read(f.input.key))?.status).toBe("paused");
});

test("watch reads stored prerequisites without executing Done commands or host probes", async () => {
  await f.deps.registry.write({ ...f.prior, done: 'command ["bun","test"]' });
  await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  const deps = {
    ...f.deps,
    run: async () => {
      throw new Error("watch executed a command");
    },
  };
  expect((await queueTick(deps))[0]).toContain("live checks run on explicit");
  expect(await queueTick(deps)).toEqual([]);
  expect(f.creates()).toBe(0);
});

test("watch reports a malformed predecessor without losing ready notices before or after it", async () => {
  const damaged = { ...f.prior, key: "damaged-predecessor" };
  await f.deps.registry.write(damaged);
  await enqueueLaunch(f.deps, { ...f.input, key: "aaa-ready" }, [f.prior.key]);
  await enqueueLaunch(f.deps, { ...f.input, key: "mmm-damaged" }, [damaged.key]);
  await enqueueLaunch(f.deps, { ...f.input, key: "zzz-ready" }, [f.prior.key]);
  const invalid = '{"private contents":';
  writeFileSync(f.deps.registry.path(damaged.key), invalid);
  const ready = (key: string) => `LANE_QUEUE_READY ${key}; live checks run on explicit dori queue start ${key}`;

  expect(await queueTick(f.deps)).toEqual([
    ready("aaa-ready"),
    "LANE_QUEUE_WARN mmm-damaged unreadable predecessor record: damaged-predecessor",
    ready("zzz-ready"),
  ]);
  expect(await queueTick(f.deps)).toEqual([]);
  expect(readFileSync(f.deps.registry.path(damaged.key), "utf8")).toBe(invalid);
  await f.deps.registry.write(damaged);
  expect(await queueTick(f.deps)).toEqual([ready("mmm-damaged")]);
  expect(f.creates()).toBe(0);
});

test.each(["invalid queue JSON", "invalid queue record"])(
  "one damaged entry (%s) is visible without hiding valid boot/list/watch entries",
  async (reason) => {
    const valid = await enqueueLaunch(f.deps, f.input, [f.prior.key]);
    if (reason === "invalid queue JSON") {
      writeFileSync(store().path("damaged"), "{");
    } else {
      store().write({ ...valid, input: { ...valid.input, key: "damaged" }, after: [] });
    }
    const scan = store().scan();
    expect(scan.entries.map((entry) => entry.input.key)).toEqual([f.input.key]);
    expect(scan.problems[0]).toContain("damaged");
    const listed = await cli("queue", "list");
    expect(listed.code).toBe(1);
    expect(JSON.parse(listed.out)[0].input.key).toBe(f.input.key);
    expect(listed.err).toContain("QUEUE_UNREADABLE damaged");
    const boot = await cli("boot");
    expect(boot.code).not.toBe(0);
    expect(boot.out).toContain(`QUEUE ${f.input.key} pending`);
    expect(boot.out).toContain("QUEUE_UNREADABLE damaged");
    expect(await queueTick(f.deps)).toEqual([
      `LANE_QUEUE_WARN damaged.json: ${reason}: damaged`,
      `LANE_QUEUE_READY ${f.input.key}; live checks run on explicit dori queue start ${f.input.key}`,
    ]);
    const start = await cli("queue", "start", "damaged");
    expect(start.code).toBe(1);
    expect(start.err).toContain(reason);
    const independent = await launchLane(f.deps, { ...f.input, key: "independent" });
    expect(independent.startup).toContain("STARTUP_OK");
    await expect(launchLane(f.deps, { ...f.input, key: "damaged" })).rejects.toThrow(reason);
  },
);

test.each([
  { patch: { key: "lead" }, reason: "reserved" },
  { patch: { done: "merged" }, reason: "not checkable" },
  { patch: { budget: { tokens: -1 } }, reason: "invalid tokens" },
  { patch: { key: "existing-lane" }, reason: "already registered" },
])("queue preparation preserves the ordinary launch validation: %j", async ({ patch, reason }) => {
  await f.deps.registry.write({ ...f.prior, key: "existing-lane" });
  await expect(enqueueLaunch(f.deps, { ...f.input, ...patch }, [f.prior.key])).rejects.toThrow(reason);
  expect(store().scan().entries).toEqual([]);
  expect(f.creates()).toBe(0);
});

test("queued templates replay the exact snapshot including quoted footer markers and trailing whitespace", async () => {
  mkdirSync(join(f.state.dir, "templates"));
  const template = join(f.state.dir, "templates", "build.md");
  const quoted = "<!-- dori launch: footer start -->\nQuoted prior footer\n<!-- dori launch: footer end --> \t\n";
  const body = `Build first.\r\n${quoted}`;
  writeFileSync(template, "Build {{branch}}.\r\n{{quoted}}");
  const entry = await enqueueLaunch(f.deps, { ...f.input, template: "build", variables: { branch: "first", quoted } }, [
    f.prior.key,
  ]);
  expect(entry.briefText).toBe(body);
  writeFileSync(template, "Changed after queueing.");
  expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(0);
  const lane = await f.deps.registry.read(f.input.key);
  if (!lane) throw new Error("queued template did not create its lane");
  expect(readFileSync(lane.brief, "utf8")).toStartWith(`${BRIEF_START}\n${body}\n\n<!-- dori launch: footer start -->`);
});

test("failed pre-registration creation needs explicit cancel and a fresh reservation", async () => {
  const original = await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  const deps = {
    ...f.deps,
    run: async (...args: Parameters<typeof f.deps.run>) =>
      args[0][0] === "herdr" && args[0][1] === "tab" && args[0][2] === "create"
        ? { code: 1, out: "", err: '{"error":{"code":"server_not_running"}}' }
        : f.deps.run(...args),
  };
  await expect(startQueued(deps, f.input.key, roomy)).rejects.toThrow("session create failed");
  expect(existsSync(join(f.state.dir, "queued-briefs", `${original.id}.md`))).toBe(false);
  expect(readdirSync(join(f.state.dir, "queued-briefs", `${original.id}.md.attempts`))).toEqual([]);
  expect(store().read(f.input.key)?.status).toBe("starting");
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
  await expect(startQueued(f.deps, f.input.key, roomy)).rejects.toThrow("no launch retried");
  await cancelQueued(f.deps, f.input.key);
  expect((await enqueueLaunch(f.deps, f.input, [f.prior.key])).id).not.toBe(original.id);
  expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(0);
  expect(f.creates()).toBe(1);
});

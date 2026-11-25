import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { enqueueLaunch, startQueued } from "../src/launch-queue.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { checkDone } from "../src/signals.ts";
import { queueFixture, roomy, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
beforeEach(async () => {
  f = await queueFixture();
});
afterEach(() => f.state.done());

const doneSignal = "file done.marker";

const linkedDirectories = async () => {
  const physical = join(f.state.dir, "physical");
  const child = join(physical, "child");
  const lexical = join(f.state.dir, "lexical");
  const link = join(lexical, "link");
  mkdirSync(child, { recursive: true });
  mkdirSync(lexical);
  symlinkSync(child, link, "dir");
  writeFileSync(join(lexical, "done.marker"), "marker in the lexical directory only");
  const configPath = join(f.state.dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...f.deps.config, defaultCwd: "~/lexical/link/.." }));
  return { config: await loadConfig(configPath, f.state.dir), physical, lexical, link };
};

test("an ordinary launch and relative Done check use the same lexical cwd with a symlink in the config", async () => {
  const { config, lexical } = await linkedDirectories();
  let runtimeReadback: string | undefined;
  f.world.onCreate = (spec) => {
    // The runtime boundary follows the filesystem spelling, then the child opens a relative file there.
    const probe = Bun.spawnSync(
      [process.execPath, "-e", 'console.log(process.cwd()); console.log(await Bun.file("done.marker").exists())'],
      { cwd: realpathSync.native(spec.cwd), stdout: "pipe", stderr: "pipe" },
    );
    if (probe.exitCode !== 0) throw new Error(probe.stderr.toString());
    runtimeReadback = probe.stdout.toString().trim();
  };
  const deps: FlowDeps = { ...f.deps, config };

  await launchLane(deps, { ...f.input, done: doneSignal });

  const lane = await deps.registry.read(f.input.key);
  if (!lane?.cwd) throw new Error("launch did not record a working directory");
  expect(runtimeReadback).toBe(`${realpathSync.native(lexical)}\ntrue`);
  expect(lane.cwd).toBe(lexical);
  expect(await checkDone(lane.done, deps.run, { cwd: lane.cwd })).toMatchObject([{ ok: true }]);
});

for (const source of ["relative --cwd", "absolute --cwd", "home-relative defaultCwd", "absolute symlink"] as const) {
  const followsParent = source !== "absolute symlink";
  // Win32 resolves `..` lexically before following the link. Plain link canonicalization is still portable.
  const description = followsParent ? "follows the link before resolving its parent" : "pins the link target";
  test.skipIf(process.platform === "win32" && followsParent)(`queued ${source} ${description}`, async () => {
    const { config, physical, lexical, link } = await linkedDirectories();
    const expected = realpathSync.native(followsParent ? physical : join(physical, "child"));
    const launch = { ...f.input, done: doneSignal };
    const input =
      source === "home-relative defaultCwd"
        ? launch
        : {
            ...launch,
            cwd: `${source === "relative --cwd" ? relative(process.cwd(), link) : link}${followsParent ? `${sep}..` : ""}`,
          };

    await enqueueLaunch({ ...f.deps, config }, input, [f.prior.key]);

    expect(new LaunchQueue(f.state.dir).read(f.input.key)?.input.cwd).toBe(expected);
    renameSync(link, `${link}.old`);
    symlinkSync(lexical, link, "dir");
    const created: string[] = [];
    f.world.onCreate = (spec) => {
      created.push(spec.cwd);
    };
    expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(0);
    const lane = await f.deps.registry.read(f.input.key);
    if (!lane?.cwd) throw new Error("queued launch did not record a working directory");
    expect(lane.cwd).toBe(expected);
    expect(created).toEqual([expected]);
    expect(await checkDone(lane.done, f.deps.run, { cwd: lane.cwd })).toMatchObject([{ ok: false }]);
  });
}

test.each(["missing", "file"])("enqueuing a %s cwd leaves no reservation", async (kind) => {
  const cwd = kind === "file" ? f.input.brief : join(f.state.dir, "absent");

  await expect(enqueueLaunch(f.deps, { ...f.input, cwd }, [f.prior.key])).rejects.toThrow(
    "queue cwd must be an existing directory",
  );
  expect(new LaunchQueue(f.state.dir).read(f.input.key)).toBeNull();
  expect(f.creates()).toBe(0);
});

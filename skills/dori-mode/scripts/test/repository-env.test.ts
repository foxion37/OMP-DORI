import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lane } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// Supply ambient variables at process startup, not only in Bun test's process.env view.
const observe = (expression: string, env: Record<string, string | undefined>): unknown => {
  const source = `
    import { existsSync } from "node:fs";
    import { closeLane, watchTick } from ${JSON.stringify(new URL("../src/done-flow.ts", import.meta.url).href)};
    import { discoverWorktrees, unpushedWork } from ${JSON.stringify(new URL("../src/close-worktrees.ts", import.meta.url).href)};
    import { run, type Runner } from ${JSON.stringify(new URL("../src/run.ts", import.meta.url).href)};
    // Exercise real Git ownership checks without inheriting runner-wide trust.
    const differentOwner: Runner = (argv, opts) => { const child = opts?.env ?? process.env;
      return run(argv, { ...opts, env: { ...child, GIT_CONFIG_NOSYSTEM: "1", GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_GLOBAL: child.GIT_CONFIG_GLOBAL ?? ${JSON.stringify(join(env["HOME"] ?? "", "empty.gitconfig"))} } }); };
    import { depsFor, fakeClock, newWorld } from ${JSON.stringify(new URL("./fakes.ts", import.meta.url).href)};
    console.log(JSON.stringify(${expression}));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--no-env-file", "-e", source], { env, encoding: "utf8" }));
};

describe("Dori-owned repository operations", () => {
  let state: ReturnType<typeof withState>;
  let fixtureEnv: Record<string, string | undefined>;
  let input: string;
  let foreign: string;
  let lane: Lane;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: state.dir, env: fixtureEnv, encoding: "utf8" });
  const poisoned = () => ({ ...fixtureEnv, GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign });
  const unpushed = (
    seen: Lane = { ...lane, worktrees: [input] },
    env: Record<string, string | undefined> = poisoned(),
    runner = "run",
  ) =>
    observe(
      `await unpushedWork({
        ...depsFor(newWorld(), fakeClock(0), ${JSON.stringify(state.dir)}, { defaultCwd: ${JSON.stringify(input)} }),
        run: ${runner}, exists: existsSync,
      }, ${JSON.stringify(seen)})`,
      env,
    );

  beforeEach(() => {
    state = withState();
    const config = join(state.dir, "empty.gitconfig");
    writeFileSync(config, "");
    fixtureEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      HOME: state.dir,
      XDG_CONFIG_HOME: join(state.dir, "xdg"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: config,
    };
    input = join(state.dir, "input");
    foreign = join(state.dir, "foreign");
    for (const repo of [input, foreign]) {
      git("init", "--quiet", "--initial-branch", repo === input ? "main" : "repository-env-foreign", repo);
      writeFileSync(join(repo, "tracked.txt"), "initial\n");
      git("-C", repo, "add", "tracked.txt");
      git(
        "-C",
        repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "initial",
      );
      git("-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    }
    lane = {
      key: "repository-env",
      title: "Repository environment regression",
      thread: "chat:test/123",
      brief: join(state.dir, "brief.md"),
      done: "merged acme/app#1",
      cwd: input,
      openedAt: new Date(0).toISOString(),
    };
  });
  afterEach(() => state.done());
  test("discovery uses its input repository without changing ordinary Git's environment", () => {
    expect(
      observe(
        `await (async () => {
      const discovered = await discoverWorktrees(${JSON.stringify(lane)}, run);
      const ordinary = await run(["git", "-C", ${JSON.stringify(input)}, "rev-parse", "--show-toplevel"]);
      return {
        discovered,
        gitDir: process.env.GIT_DIR,
        ordinary,
      };
    })()`,
        poisoned(),
      ),
    ).toEqual({
      discovered: [],
      gitDir: join(foreign, ".git"),
      ordinary: { code: 0, out: git("-C", foreign, "rev-parse", "--show-toplevel").trim(), err: "" },
    });
  });

  test("a dirty owned checkout is not cleared by a clean foreign repository", () => {
    writeFileSync(join(input, "tracked.txt"), "changed\n");
    expect(unpushed()).toEqual([`unpushed work in ${input}`]);
  });

  test("an unpushed owned commit is not cleared by a pushed foreign repository", () => {
    git(
      "-C",
      input,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "ahead",
    );
    expect(unpushed()).toEqual([`unpushed work in ${input}`]);
  });

  test("a real non-checkout remains skippable despite foreign Git variables", () => {
    const outside = join(state.dir, "outside");
    mkdirSync(outside);
    expect(unpushed({ ...lane, cwd: outside })).toEqual([]);
    expect(unpushed({ ...lane, cwd: outside, worktrees: [] })).toEqual([]);
    expect(unpushed({ ...lane, cwd: join(outside, "absent"), worktrees: [] })).toEqual([]);
  });

  test("an unreadable fallback repository is held when Git trust was supplied only by environment", () => {
    const config = join(state.dir, "trusted.gitconfig");
    const topLevel = git("-C", input, "rev-parse", "--show-toplevel").trim();
    writeFileSync(config, `[safe]\n  directory = ${JSON.stringify(topLevel)}\n`);
    const env = {
      ...fixtureEnv,
      GIT_CONFIG_GLOBAL: config,
      LC_ALL: "C",
    };
    const argv = JSON.stringify(["git", "-C", input, "rev-parse", "--is-inside-work-tree"]);
    expect(
      observe(
        `({
      trusted: (await differentOwner(${argv})).code,
      refused: await differentOwner(${argv}, { env: { ...process.env,
        GIT_CONFIG_GLOBAL: ${JSON.stringify(join(state.dir, "empty.gitconfig"))},
      } }),
    })`,
        env,
      ),
    ).toMatchObject({
      trusted: 0,
      refused: { code: 128, err: expect.stringContaining("detected dubious ownership") },
    });
    writeFileSync(join(input, "tracked.txt"), "changed\n");
    expect(unpushed(lane, env, "differentOwner")).toEqual([`unpushed work in ${input} (git state unreadable)`]);
  });

  test("Done holds when discovery in the default repo cannot see a dirty owned worktree", () => {
    const outside = join(state.dir, "outside");
    const owned = join(state.dir, "repository-env-owned");
    mkdirSync(outside);
    git("-C", input, "worktree", "add", "--quiet", "-b", "repository-env-owned", owned);
    writeFileSync(join(owned, "tracked.txt"), "changed\n");
    const reported = git("-C", owned, "rev-parse", "--show-toplevel").trim();
    const watch = (unreadable: boolean) =>
      observe(
        `await (async () => {
      const lane = ${JSON.stringify({
        ...lane,
        cwd: outside,
        status: "done-claimed",
        claim: { at: lane.openedAt, evidence: "fixture", emitted: true },
      })};
      const root = ${JSON.stringify(input)};
      const deps = depsFor(newWorld(), fakeClock(360_000), ${JSON.stringify(join(state.dir, String(unreadable)))},
        { defaultCwd: root, closeAfterMin: 5 });
      const runGit: Runner = (argv, opts) => {
        if (argv[0] !== "git") return deps.run(argv, opts);
        if (argv[3] === "worktree" && argv[4] === "remove") throw new Error("unexpected worktree removal");
        return (${unreadable} && argv[2] === root ? differentOwner : run)(argv, opts);
      };
      await deps.registry.write(lane);
      return await watchTick({ ...deps, run: runGit, exists: existsSync });
    })()`,
        fixtureEnv,
      );
    expect(watch(false)).toEqual([`LANE_NOT_DONE ${lane.key} unpushed work in ${reported}`]);
    expect(watch(true)).toEqual([`LANE_NOT_DONE ${lane.key} unpushed work in ${input} (git state unreadable)`]);
    expect(existsSync(join(owned, "tracked.txt"))).toBe(true);
  });

  test("closing removes only the owned worktree, not a matching foreign worktree", () => {
    const owned = join(state.dir, "repository-env-owned");
    const unrelated = join(state.dir, "repository-env-unrelated");
    git("-C", input, "worktree", "add", "--quiet", "-b", "repository-env-owned", owned);
    git("-C", foreign, "worktree", "add", "--quiet", "-b", "repository-env-unrelated", unrelated);
    expect(
      observe(
        `await (async () => {
      const lane = ${JSON.stringify({ ...lane, worktrees: [owned] })};
      const deps = depsFor(newWorld(), fakeClock(0), ${JSON.stringify(state.dir)}, {
        defaultCwd: ${JSON.stringify(input)}, hooks: {},
      });
      const original = deps.run;
      await deps.registry.write(lane);
      const result = await closeLane({ ...deps, exists: existsSync,
        run: (argv, opts) => argv[0] === "git" ? run(argv, opts) : original(argv, opts),
      }, lane, "repository cleanup regression");
      return { closed: result.closed, owned: existsSync(${JSON.stringify(owned)}),
        unrelated: existsSync(${JSON.stringify(unrelated)}) };
    })()`,
        poisoned(),
      ),
    ).toEqual({ closed: true, owned: false, unrelated: true });
  });
});

test("Runner forwards an explicit environment without changing its inherited default", () => {
  const argv = JSON.stringify([
    process.execPath,
    "-e",
    'process.stdout.write(process.env.DORI_RUNNER_ENV_FIXTURE ?? "missing")',
  ]);
  expect(
    observe(
      `({
    explicit: await run(${argv}, { env: { DORI_RUNNER_ENV_FIXTURE: "explicit" } }),
    empty: await run(${argv}, { env: {} }),
    inherited: await run(${argv}),
    unchanged: process.env.DORI_RUNNER_ENV_FIXTURE,
  })`,
      { ...process.env, DORI_RUNNER_ENV_FIXTURE: "ambient" },
    ),
  ).toEqual({
    explicit: { code: 0, out: "explicit", err: "" },
    empty: { code: 0, out: "missing", err: "" },
    inherited: { code: 0, out: "ambient", err: "" },
    unchanged: "ambient",
  });
});

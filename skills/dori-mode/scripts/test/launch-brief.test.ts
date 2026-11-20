import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const DONE = "closed acme/app#1";
let state: TestState;
let world: World;
let briefs: string;
beforeEach(() => {
  state = withState();
  world = newWorld();
  mkdirSync(join(state.dir, "briefs"));
  briefs = fs.realpathSync(join(state.dir, "briefs"));
});
afterEach(() => {
  chmodSync(briefs, 0o700);
  state.done();
});

// POSIX-only: a read-only directory (0500) and file modes have no meaning on Windows.
const posix = test.skipIf(process.platform === "win32");

// The lane's tab, as herdr answers a create.
const withTab = (base: FlowDeps): FlowDeps => ({
  ...base,
  run: async (argv, opts) =>
    argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
      : base.run(argv, opts),
});

posix("a brief that cannot be written stops the launch before a tab or a lane record exists", async () => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  chmodSync(briefs, 0o500);
  const deps = depsFor(world, fakeClock(T0), state.dir);

  await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: DONE })).rejects.toThrow(
    "brief not writable",
  );

  expect(world.calls.filter((c) => c[0] === "herdr" && c[1] === "tab")).toEqual([]);
  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(readFileSync(brief, "utf8")).toBe("brief");
  expect(readdirSync(briefs)).toEqual(["lane.md"]);
});

test("a brief that cannot be put in place after registration undoes the record, the tab and the staged brief", async () => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
  const original = fs.writeFileSync;
  let refused = false;
  const spy = spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]) === brief && !refused) {
      refused = true;
      throw new Error("EACCES: permission changed");
    }
    original(...args);
  }) as typeof fs.writeFileSync);
  try {
    await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: DONE })).rejects.toThrow(
      "brief not written: EACCES: permission changed",
    );
  } finally {
    spy.mockRestore();
  }

  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "close")).toEqual([["herdr", "tab", "close", "w:t9"]]);
  expect(readFileSync(brief, "utf8")).toBe("brief");
  expect(readdirSync(briefs)).toEqual(["lane.md"]);
});

test("a staged brief that cannot be removed does not stop the record and tab rollback", async () => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "brief");
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
  const write = fs.writeFileSync;
  const remove = fs.rmSync;
  const spies = [
    spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === brief) throw new Error("EACCES: directory locked");
      write(...args);
    }) as typeof fs.writeFileSync),
    spyOn(fs, "rmSync").mockImplementation(((path: fs.PathLike, options?: fs.RmOptions) => {
      if (String(path).endsWith(".launch")) throw new Error("EACCES: directory locked");
      remove(path, options);
    }) as typeof fs.rmSync),
  ];
  try {
    await expect(launchLane(deps, { key: "brief-lane", title: "t", brief, done: DONE })).rejects.toThrow(
      "brief not written",
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  expect(await deps.registry.read("brief-lane")).toBeNull();
  expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "close")).toEqual([["herdr", "tab", "close", "w:t9"]]);
  expect(readFileSync(brief, "utf8")).toBe("brief");
});

test("a brief that links to a template is written through the link", async () => {
  const template = join(briefs, "template.md");
  writeFileSync(template, "template");
  const brief = join(briefs, "lane.md");
  symlinkSync(template, brief);
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));

  await launchLane(deps, { key: "linked-lane", title: "t", brief, done: DONE });

  expect(lstatSync(brief).isSymbolicLink()).toBe(true);
  expect(readFileSync(template, "utf8")).toContain("template");
  expect(readdirSync(briefs).sort()).toEqual(["lane.md", "template.md"]);
});

posix.each([0o600, 0o640])("staging preserves an existing brief's %s permissions under either umask", async (mode) => {
  const brief = join(briefs, "private.md");
  writeFileSync(brief, "owner instructions");
  chmodSync(brief, mode);
  const before = process.umask(0);
  try {
    const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
    await launchLane(deps, { key: "private-lane", title: "t", brief, done: DONE });
    expect(statSync(brief).mode & 0o777).toBe(mode);
    process.umask(0o077);
    await launchLane(deps, { key: "second-lane", title: "t", brief, done: DONE });
    expect(statSync(brief).mode & 0o777).toBe(mode);
  } finally {
    process.umask(before);
  }
});

// A group the test may give a file without privileges: one of ours other than the one new files get.
const egid = process.getegid?.();
const otherGroup = process.getgroups?.().find((gid) => gid !== egid);

test.skipIf(otherGroup === undefined)("staging keeps an existing brief's group and its readers", async () => {
  const brief = join(briefs, "shared.md");
  writeFileSync(brief, "team instructions");
  chmodSync(brief, 0o640);
  fs.chownSync(brief, process.geteuid?.() ?? -1, otherGroup!);
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));

  await launchLane(deps, { key: "shared-lane", title: "t", brief, done: DONE });

  expect(readFileSync(brief, "utf8")).toContain("team instructions");
  expect([statSync(brief).gid, statSync(brief).mode & 0o777]).toEqual([otherGroup!, 0o640]);
});

test("the brief is written in place: its inode and a hard link to it stay", async () => {
  const brief = join(briefs, "lane.md");
  const shared = join(briefs, "shared.md");
  writeFileSync(brief, "linked instructions");
  fs.linkSync(brief, shared);
  const inode = statSync(brief).ino;
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));

  await launchLane(deps, { key: "inode-lane", title: "t", brief, done: DONE });

  expect([statSync(brief).ino, statSync(brief).nlink]).toEqual([inode, 2]);
  expect(readFileSync(shared, "utf8")).toBe(readFileSync(brief, "utf8"));
  expect(readdirSync(briefs).sort()).toEqual(["lane.md", "shared.md"]);
});

// POSIX ACLs: the file's own entries, and a directory default a new file would inherit.
const setAcl = (...args: string[]): boolean => Bun.spawnSync(["setfacl", ...args]).exitCode === 0;
const aclGroup = otherGroup ?? egid;
const aclsWork = (() => {
  if (aclGroup === undefined || !Bun.which("setfacl") || !Bun.which("getfacl")) return false;
  const probe = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "dori-acl-"));
  try {
    return setAcl("-m", `g:${aclGroup}:r`, probe);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

test.skipIf(!aclsWork).each(["own", "inherited"] as const)("the brief keeps its ACL (%s entries)", async (kind) => {
  const brief = join(briefs, "lane.md");
  writeFileSync(brief, "acl instructions");
  chmodSync(brief, 0o640);
  // own: a named group may read while the owning group may not; inherited: the directory would grant a reader.
  expect(
    kind === "own" ? setAcl("-m", `g::-,g:${aclGroup}:r`, brief) : setAcl("-d", "-m", `g:${aclGroup}:r`, briefs),
  ).toBe(true);
  const getAcl = ["getfacl", "-cp", brief];
  const before = Bun.spawnSync(getAcl).stdout.toString();
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));

  await launchLane(deps, { key: "acl-lane", title: "t", brief, done: DONE });

  expect(readFileSync(brief, "utf8")).toContain("acl instructions");
  expect(Bun.spawnSync(getAcl).stdout.toString()).toBe(before);
});

test.each([false, true])("a read-only brief or linked template refuses replacement (%s)", async (linked) => {
  const target = join(briefs, linked ? "template.md" : "lane.md");
  const brief = join(briefs, "lane.md");
  writeFileSync(target, "protected instructions");
  chmodSync(target, 0o444);
  if (linked) symlinkSync(target, brief);
  try {
    const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
    await expect(launchLane(deps, { key: "readonly-lane", title: "t", brief, done: DONE })).rejects.toThrow(
      "brief not writable",
    );
    expect(await deps.registry.read("readonly-lane")).toBeNull();
    expect(world.calls.some((argv) => argv[0] === "herdr" && argv[1] === "tab")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("protected instructions");
    expect(statSync(target).mode & 0o777).toBe(0o444);
    expect(lstatSync(brief).isSymbolicLink()).toBe(linked);
    expect(readdirSync(briefs).sort()).toEqual(linked ? ["lane.md", "template.md"] : ["lane.md"]);
  } finally {
    chmodSync(target, 0o600);
  }
});

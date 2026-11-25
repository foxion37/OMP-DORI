import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platform } from "../../../../src/platform/index.ts";

import { type CatalyConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import { Registry } from "../src/registry.ts";
import { ChosenRuntimes, type Clock, type Ran, type Runner } from "../src/run.ts";

import { FakeHeadless } from "./fake-headless.ts";
import { href, sid, type FakeSession, type World } from "./fake-session.ts";

export { href, sid } from "./fake-session.ts";
export type { FakeSession, World } from "./fake-session.ts";

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({
  prState: "MERGED",
  issueState: "CLOSED",
  aheadCount: "0",
  dirty: "",
  sessions: {},
  next: 0,
  calls: [],
});

/** A live native lane session `sid(n)` in the world, and the registry fields that bind a lane to it. */
export const nativeLane = (
  w: World,
  n: number,
  patch: Partial<FakeSession> = {},
): Pick<Lane, "sessionRef" | "session" | "sessionFile"> => {
  const id = sid(n);
  const session: FakeSession = {
    status: "idle",
    role: "lane",
    sessionId: `session-${n}`,
    sessionFile: `/sessions/session-${n}.jsonl`,
    pid: 4000 + n,
    cwd: "/repo",
    goal: { status: "active", objective: "ship it" },
    held: false,
    ...patch,
  };
  w.sessions[id] = session;
  return {
    sessionRef: href(id),
    ...(session.sessionId === undefined ? {} : { session: session.sessionId }),
    ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
  };
};

/** A live native harness lead `sid(n)` attested as session `owner`; returns its `leadPane` address. */
export const nativeLead = (w: World, n: number, patch: Partial<FakeSession> = {}): string => {
  const id = sid(n);
  w.sessions[id] = {
    status: "idle",
    role: "cataly",
    harnessRole: "lead",
    sessionId: "owner",
    sessionFile: "/sessions/owner.jsonl",
    pid: 4000 + n,
    cwd: "/repo",
    goal: { status: "none" },
    held: false,
    ...patch,
  };
  return `headless:${id}`;
};
export const fakeRunner =
  (w: World): Runner =>
  async (argv) => {
    w.calls.push([...argv]);
    const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
    const [cmd, a1] = argv;
    if (cmd === "ps" && a1 === "-A")
      return ok(
        (w.procs ?? []).map((p) => (argv.includes("pid=") ? String(p.pid) : `${p.pid} ${p.ppid} ${p.cmd}`)).join("\n"),
      );
    if (cmd === "ps" && argv.includes("lstart=")) return ok("Thu Jan  1 12:00:00 2026 GMT");
    if (cmd === "git" && argv.includes("worktree") && argv.includes("list"))
      return ok(
        w.worktreeList ?? `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`,
      );
    if (cmd === "git" && argv.includes("rev-parse") && argv.includes("--is-inside-work-tree"))
      return ok(w.isGitRepo ?? "true");
    // Outside a readable checkout, git status and rev-list fail as real git does (exit 128).
    if (cmd === "git" && w.isGitRepo === "false" && (argv.includes("status") || argv.includes("rev-list")))
      return { code: 128, out: "", err: "fatal: not a git repository" };
    if (cmd === "git" && argv.includes("status"))
      return ok(typeof w.dirty === "string" ? w.dirty : (w.dirty[argv[2] ?? ""] ?? ""));
    if (cmd === "git" && argv.includes("rev-list"))
      return ok(typeof w.aheadCount === "string" ? w.aheadCount : (w.aheadCount[argv[2] ?? ""] ?? "0"));
    if (cmd === "git") return ok();
    if (cmd === "gh" && a1 === "pr")
      return ok(
        JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }),
      );
    if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
    if (cmd === "notify") return ok();
    if (cmd === "tern" && w.tern) {
      const r = await w.tern.exec(cmd, argv.slice(1));
      return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
    }
    return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
  };

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export type TestState = { dir: string; done: () => void };

export const withState = (): TestState => {
  const dir = mkdtempSync(join(tmpdir(), "cataly-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

/** On Windows, `inbound telegram` refuses before reading any other argument. */
export const refusedOnWindows = (args: readonly string[], err: string): string =>
  process.platform === "win32" && args[0] === "inbound" && args[1] === "telegram"
    ? "Telegram intake is not supported on Windows"
    : err;

/** Runtimes whose only runtime is the world's fake headless supervisor. */
export const fakeRuntimes = (w: World, stateDir: string): ChosenRuntimes => {
  const runtime = new FakeHeadless(w, stateDir);
  return new ChosenRuntimes(
    () => ({ kind: "headless", source: "default" }),
    () => runtime,
  );
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<CatalyConfig> = {}): FlowDeps => {
  const config: CatalyConfig = {
    ...defaultConfig("/home/test"),
    stateDir,
    defaultCwd: "/repo",
    ...patch,
  };
  return {
    run: fakeRunner(w),
    clock,
    registry: new Registry(stateDir),
    config,
    exists: () => true,
    env: {},
    rts: fakeRuntimes(w, stateDir),
    platform: {
      ...platform,
      procStat(pid) {
        const process = w.procs?.find((entry) => entry.pid === pid);
        if (!process) throw Object.assign(new Error(`process ${pid} is absent`), { code: "ENOENT" });
        return {
          zombie: false,
          ppid: process.ppid,
          pgid: pid,
          tpgid: pid,
          startTicks: w.procStartTicks?.[pid] ?? String(pid),
        };
      },
      bootId: () => w.bootId ?? "fixture-boot",
    },
  };
};

/** Texts the fake supervisor accepted or refused, in delivery order. */
export const sent = (w: World): string[] =>
  w.calls.filter((c) => c[0] === "headless" && c[1] === "deliver").map((c) => c[3] ?? "");

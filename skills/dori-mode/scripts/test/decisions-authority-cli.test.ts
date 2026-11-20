import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Decisions } from "../src/decisions.ts";
import { settled } from "../src/decisions-record.ts";
import { paneStateDir, paneStatePath, readPaneState } from "../src/lane-state.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { Worklog } from "../src/worklog.ts";
import { laneState, type TestState, withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

const T0 = Date.parse("2026-11-04T00:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const cliIn = (dir: string) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  return (...args: string[]) =>
    run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, process.execPath, cli, ...args]);
};

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("the lead chooses a routine decision's option with its reason, keeping the question's source and thread", async () => {
  // Given a routine decision in thread d:t, linked to an open worklog item.
  const work = new Worklog(state.dir).add("Pick a log format", "d:t/1", Date.now());
  const invoke = cliIn(state.dir);
  const asked = JSON.parse(
    (
      await invoke(
        "decision",
        "ask",
        "Log format?",
        "--source",
        "d:t/1",
        "--thread",
        "d:t",
        "--kind",
        "routine",
        "--option",
        "JSON lines",
        "--option",
        "plain text",
        "--recommend",
        "1",
        "--worklog",
        work.id,
      )
    ).out,
  );
  expect(asked).toMatchObject({ kind: "routine", thread: "d:t", source: "d:t/1" });
  // Then the digest names it as routine.
  expect((await invoke("decision", "digest")).out.trim()).toBe(
    `${asked.id} 0h lane=- kind=routine Log format? | 1) JSON lines (recommended) | 2) plain text`,
  );
  // Record a supplied message reference, not a verified delivery.
  const chosen = await invoke(
    "decision",
    "choose",
    asked.id,
    "1",
    "--reason",
    "matches the existing parser",
    "--source",
    "d:t/20",
    "--thread",
    "d:t",
  );
  // A fresh reader sees the choice, reason, and reference without changing the question's source or thread.
  expect([chosen.code, chosen.err]).toEqual([0, ""]);
  const item = JSON.parse(chosen.out);
  expect(item).toEqual({
    id: asked.id,
    question: "Log format?",
    source: "d:t/1",
    askedAt: asked.askedAt,
    thread: "d:t",
    kind: "routine",
    options: ["JSON lines", "plain text"],
    recommend: 1,
    worklog: work.id,
    answeredAt: item.answeredAt,
    answer: "JSON lines",
    option: 1,
    answerSource: "d:t/20",
    authority: "lead",
    reason: "matches the existing parser",
  });
  const ledger = new Decisions(state.dir);
  expect(ledger.read()).toEqual({ items: [item], problems: [], warnings: [] });
  // And the record is a choose event, never an owner answer.
  const last = JSON.parse(readFileSync(ledger.path, "utf8").trim().split("\n").at(-1) ?? "{}");
  expect(last).toEqual({
    op: "choose",
    id: asked.id,
    at: item.answeredAt,
    n: last.n,
    option: 1,
    reason: "matches the existing parser",
    source: "d:t/20",
    thread: "d:t",
  });
  // And the worklog item says who chose, and the decision is no longer in the digest.
  expect(new Worklog(state.dir).open()[0]?.notes.map((note) => note.text)).toEqual([
    `decision ${asked.id} chosen by the lead: JSON lines`,
  ]);
  expect((await invoke("decision", "digest")).out).toBe("");
});

test("a routine ask needs two options and a thread; an unknown kind is refused", async () => {
  // Given an empty ledger.
  const ledger = new Decisions(state.dir);
  // When asking routine with no options, one option, or no thread; then each is refused and nothing is written.
  const open = { question: "Name the bot?", source: "s:1", thread: "d:t", kind: "routine" } as const;
  expect(() => ledger.ask(open, T0)).toThrow(
    "a routine decision needs at least 2 options; an open question is the owner's",
  );
  expect(() => ledger.ask({ ...open, options: ["Dori"] }, T0)).toThrow("a routine decision needs at least 2 options");
  expect(() => ledger.ask({ question: "Q?", source: "s:1", kind: "routine", options: ["a", "b"] }, T0)).toThrow(
    "a routine decision needs the thread of the work it belongs to",
  );
  expect(existsSync(ledger.path)).toBe(false);
  const invoke = cliIn(state.dir);
  const ask = ["decision", "ask", "Q?", "--source", "s:1", "--option", "a", "--option", "b"];
  const unknown = await invoke(...ask, "--thread", "d:t", "--kind", "lead");
  expect([unknown.code, unknown.err.trim()]).toEqual([1, "--kind must be owner or routine"]);
  const none = await invoke(...ask, "--thread", "none", "--kind", "routine");
  expect([none.code, none.err.trim()]).toEqual([1, "a routine decision needs the thread of the work it belongs to"]);
  expect(existsSync(ledger.path)).toBe(false);
  await new Registry(state.dir).write({
    key: "log-lane",
    title: "logs",
    thread: "discord:c9/1",
    brief: "/b.md",
    done: "file /done.md",
    openedAt: at(0),
  });
  const laned = await invoke(...ask, "--lane", "log-lane", "--kind", "routine");
  expect(JSON.parse(laned.out)).toMatchObject({ lane: "log-lane", thread: "discord:c9/1", kind: "routine" });
  const before = readFileSync(ledger.path, "utf8");
  const mismatch = await invoke(...ask, "--lane", "log-lane", "--kind", "routine", "--thread", "discord:c9/2");
  expect([mismatch.code, mismatch.err.trim()]).toEqual([
    1,
    "routine decision belongs to the lane's thread discord:c9/1",
  ]);
  expect(readFileSync(ledger.path, "utf8")).toBe(before);
});

test("decision choose refuses a missing or swallowed value and anything but one option number, writing nothing", async () => {
  const invoke = cliIn(state.dir);
  const d = JSON.parse(
    (
      await invoke(
        "decision",
        "ask",
        "Log format?",
        "--source",
        "d:t/1",
        "--thread",
        "d:t",
        "--kind",
        "routine",
        "--option",
        "JSON lines",
        "--option",
        "plain text",
      )
    ).out,
  );
  const choose = ["decision", "choose", d.id, "1"];
  const rest = ["--reason", "r", "--source", "d:t/5", "--thread", "d:t"];
  // When a value is missing, swallowed by the next flag, or the option is not exactly one number.
  for (const [args, err] of [
    [[...choose, "--reason", "r", "--source", "d:t/5", "--thread"], "--thread needs a value"],
    [[...choose, "--reason", "--source", "d:t/5", "--thread", "d:t"], "--reason needs a value"],
    [[...choose, "--reason", "r", "--source", "--thread", "d:t"], "--source needs a value"],
    [[...choose, "--reason", "r", "--thread", "d:t"], "--source is required"],
    [[...choose, "--reason", "r", "--source", "d:t/5"], "--thread is required"],
    [[...choose, "--source", "d:t/5", "--thread", "d:t"], "decision choose needs exactly one --reason"],
    [[...choose, "--reason", "r", ...rest], "decision choose needs exactly one --reason"],
    [["decision", "choose", d.id, ...rest], "decision choose needs exactly one option number"],
    [["decision", "choose", d.id, "1", "2", ...rest], "decision choose needs exactly one option number"],
    [
      ["decision", "choose", d.id, "JSON lines", ...rest],
      `decision ${d.id} takes the lead's choice of option 1 to 2; JSON lines is not one`,
    ],
    [
      [...choose, "--reason", "r", "--source", "d:t/5", "--thread", "none"],
      `decision ${d.id} belongs to thread d:t, not none`,
    ],
    [["decision", "choose", ...rest], "decision choose needs a decision id"],
    [["decision", "ask", "Q?", "--source", "s:1", "--kind"], "--kind needs a value"],
    [["decision", "ask", "Q?", "--source", "s:1", "--kind", "--option", "a"], "--kind needs a value"],
  ] as const) {
    const result = await invoke(...args);
    // Then it is one line of refusal and nothing was written.
    expect([result.code, result.out, result.err.trim()]).toEqual([1, "", err]);
  }
  const items = new Decisions(state.dir).read().items;
  expect(items.map((item) => [item.id, settled(item)])).toEqual([[d.id, undefined]]);
});

test("a routine decision still binds the owner's reply, and the owner's answer settles it before the lead", async () => {
  // Given a routine decision posted as d:t/2.
  const invoke = cliIn(state.dir);
  const ask = ["decision", "ask", "Log format?", "--source", "d:t/1", "--thread", "d:t", "--kind", "routine"];
  const posted = await invoke(...ask, "--option", "JSON lines", "--option", "plain text", "--message", "d:t/2");
  const d = JSON.parse(posted.out);
  // When the owner's reply to d:t/2 is matched and answered.
  expect(JSON.parse((await invoke("decision", "match", "d:t/2")).out)).toMatchObject({ id: d.id, kind: "routine" });
  const answered = await invoke("decision", "answer", d.id, "2", "--source", "d:t/3");
  // Then it is the owner's answer, the lead can no longer choose, and the message no longer matches.
  expect(JSON.parse(answered.out)).toMatchObject({ answer: "2", option: 2, answerSource: "d:t/3", authority: "owner" });
  const late = await invoke("decision", "choose", d.id, "1", "--reason", "r", "--source", "d:t/5", "--thread", "d:t");
  expect([late.code, late.err.trim()]).toEqual([1, `decision ${d.id} is answered: 2`]);
  expect(await invoke("decision", "match", "d:t/2")).toMatchObject({ code: 1, out: "" });
});

test("no decision answer or choice grants a native approval: the pane's open approval prompt stays as it was", async () => {
  // Given a lane pane with a native tool approval prompt open.
  laneState(state.dir, "w:p1", { approvalPending: true });
  const pane = paneStatePath(state.dir, "w:p1");
  const before = readFileSync(pane, "utf8");
  const invoke = cliIn(state.dir);
  const ask = ["--source", "d:t/1", "--thread", "d:t", "--option", "yes", "--option", "no"];
  const owner = JSON.parse((await invoke("decision", "ask", "Let the lane run the migration?", ...ask)).out);
  const lead = JSON.parse((await invoke("decision", "ask", "Run the migration now?", ...ask, "--kind", "routine")).out);
  // When the owner answers yes to one and the lead chooses yes on the other.
  const answered = await invoke("decision", "answer", owner.id, "1", "--source", "d:t/3");
  const why = ["--reason", "r", "--source", "d:t/5", "--thread", "d:t"];
  const chosen = await invoke("decision", "choose", lead.id, "1", ...why);
  // Then each prints only its decision, and the pane's record and its open approval are untouched.
  for (const result of [answered, chosen]) {
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(result.out.trim().split("\n")).toHaveLength(1);
  }
  expect(JSON.parse(answered.out)).toMatchObject({ answer: "1", option: 1, authority: "owner" });
  expect(JSON.parse(chosen.out)).toMatchObject({ answer: "yes", option: 1, authority: "lead" });
  expect(readFileSync(pane, "utf8")).toBe(before);
  expect(readPaneState(state.dir, "w:p1")?.approvalPending).toBe(true);
  expect(readdirSync(paneStateDir(state.dir))).toEqual([pane.slice(paneStateDir(state.dir).length + 1)]);
});

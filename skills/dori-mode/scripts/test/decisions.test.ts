import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Decisions } from "../src/decisions.ts";
import { DecisionError } from "../src/decisions-record.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { Worklog } from "../src/worklog.ts";
import { type TestState, withState } from "./fakes.ts";

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

test("ask, posted and a numeric answer take one decision through its life, and each reread equals what was returned", () => {
  // Given a question with two options, the second recommended.
  const ledger = new Decisions(state.dir);
  const asked = ledger.ask(
    { question: "Which store?", source: "discord:c1/100", options: ["Postgres", "SQLite"], recommend: 2 },
    T0,
  );
  const posted = ledger.posted(asked.id, "discord:c1/101", T0 + 1);
  // When the owner answers with a bare number.
  const answered = ledger.answer(asked.id, " 2 ", "discord:c1/102", T0 + 2);
  // Then the answer names option 2, and a fresh reader sees exactly the returned item.
  expect(posted.message).toBe("discord:c1/101");
  expect(answered).toEqual({
    id: asked.id,
    question: "Which store?",
    source: "discord:c1/100",
    askedAt: at(0),
    kind: "owner",
    options: ["Postgres", "SQLite"],
    recommend: 2,
    message: "discord:c1/101",
    answeredAt: at(2),
    answer: "2",
    option: 2,
    answerSource: "discord:c1/102",
    authority: "owner",
  });
  expect(new Decisions(state.dir).read()).toEqual({ items: [answered], problems: [], warnings: [] });
  expect(asked.id).toMatch(/^[0-9a-f]{8}$/);
});

test("an out-of-range number is refused and writes nothing; free text records no option; a bad recommendation is refused", () => {
  // Given a decision with two options.
  const ledger = new Decisions(state.dir);
  const d = ledger.ask({ question: "Ship now?", source: "s:1", options: ["yes", "no"] }, T0);
  const before = readFileSync(ledger.path, "utf8");
  // When answering 3 or 0; then each is refused and the record is unchanged.
  expect(() => ledger.answer(d.id, "3", "s:2", T0 + 1)).toThrow(`decision ${d.id} has options 1 to 2; 3 is not one`);
  expect(() => ledger.answer(d.id, "0", "s:2", T0 + 1)).toThrow(DecisionError);
  expect(readFileSync(ledger.path, "utf8")).toBe(before);
  // And text that only mentions an option is free text, never guessed into one.
  const free = ledger.answer(d.id, "2 but only after Friday", "s:3", T0 + 2);
  expect(free.answer).toBe("2 but only after Friday");
  expect(free.option).toBeUndefined();
  // And a recommendation needs options, within 1..n.
  expect(() => ledger.ask({ question: "Q", source: "s:4", recommend: 1 }, T0)).toThrow(
    "a recommendation needs options",
  );
  expect(() => ledger.ask({ question: "Q", source: "s:4", options: ["a"], recommend: 2 }, T0)).toThrow(
    "the recommendation must be an option number from 1 to 1",
  );
  expect(() => ledger.ask({ question: "Q", source: "s:4", options: Array(10).fill("x") }, T0)).toThrow("at most 9");
  expect(ledger.read().items).toHaveLength(1);
});

test("two decisions in one thread are answered separately, and match binds only the open one posted as that message", async () => {
  // Given two decisions asked in the same thread, each posted as its own message.
  const invoke = cliIn(state.dir);
  const ask = async (question: string, message: string): Promise<{ id: string }> =>
    JSON.parse(
      (await invoke("decision", "ask", question, "--source", "d:t/1", "--thread", "d:t", "--message", message)).out,
    );
  const first = await ask("Name the bot?", "d:t/10");
  const second = await ask("Public repo?", "d:t/11");
  // When the reply to the first message is matched and answered.
  const matched = await invoke("decision", "match", "d:t/10");
  expect(matched.code).toBe(0);
  expect(JSON.parse(matched.out)).toMatchObject({ id: first.id, question: "Name the bot?" });
  expect((await invoke("decision", "answer", first.id, "Dori", "--source", "d:t/12")).code).toBe(0);
  // Then the second is still open, the first message no longer matches, and the thread or an unknown message never does.
  const open = new Decisions(state.dir).read().items.filter((d) => d.answeredAt === undefined);
  expect(open.map((d) => d.id)).toEqual([second.id]);
  for (const ref of ["d:t/10", "d:t", "d:t/99"])
    expect(await invoke("decision", "match", ref)).toMatchObject({ code: 1, out: "" });
  expect(JSON.parse((await invoke("decision", "match", "d:t/11")).out)).toMatchObject({ id: second.id });
  // And a third decision cannot be bound to a message an open decision already holds.
  const clash = await invoke("decision", "ask", "Third?", "--source", "d:t/1", "--message", "d:t/11");
  expect([clash.code, clash.err.trim()]).toEqual([1, `message d:t/11 is already bound to open decision ${second.id}`]);
});

test("racing answers: the first wins, a later answer, withdraw or posted is a warning, and a new reader restores only open ones", () => {
  // Given two decisions, one answered and then answered again, withdrawn and reposted by writers that saw it open.
  const ledger = new Decisions(state.dir);
  const raced = ledger.ask({ question: "Raced?", source: "s:1" }, T0);
  const open = ledger.ask({ question: "Still open?", source: "s:2" }, T0 + 1);
  ledger.answer(raced.id, "first", "s:3", T0 + 2);
  const late = [
    { op: "answer", id: raced.id, at: at(3), n: "0000000a", answer: "second", source: "s:4" },
    { op: "withdraw", id: raced.id, at: at(4), n: "0000000b", reason: "moot" },
    { op: "posted", id: raced.id, at: at(5), n: "0000000c", message: "m:1" },
  ];
  appendFileSync(ledger.path, late.map((event) => `${JSON.stringify(event)}\n`).join(""));
  // When a new instance reads the record.
  const read = new Decisions(state.dir).read();
  // Then the first answer stands, each late record is a warning, not a problem, and only one decision is open.
  expect(read.items.find((d) => d.id === raced.id)?.answer).toBe("first");
  expect(read.problems).toEqual([]);
  expect(read.warnings).toEqual([
    `${ledger.path}:4: decision ${raced.id} was already answered; answer ignored`,
    `${ledger.path}:5: decision ${raced.id} was already answered; withdraw ignored`,
    `${ledger.path}:6: decision ${raced.id} was already answered; posted ignored`,
  ]);
  expect(read.items.filter((d) => d.answeredAt === undefined && d.withdrawnAt === undefined)).toEqual([
    { id: open.id, question: "Still open?", source: "s:2", askedAt: at(1), kind: "owner", options: [] },
  ]);
  // And the command refuses to resolve it again.
  expect(() => ledger.withdraw(raced.id, "late", T0 + 6)).toThrow(`decision ${raced.id} is answered: first`);
  expect(() => ledger.answer("0000beef", "x", "s:5", T0 + 6)).toThrow("decision not found: 0000beef");
});

test("a torn last line is skipped quietly, a garbage line is a problem, and control characters are refused", () => {
  // Given one decision, a garbage line, and a write cut off halfway at the end.
  const ledger = new Decisions(state.dir);
  const d = ledger.ask({ question: "Keep?", source: "s:1" }, T0);
  appendFileSync(ledger.path, `garbage\n{"op":"answer","id":"${d.id}","at`);
  // Then the torn line is not named, the garbage line is, and the decision stays open.
  const read = ledger.read();
  expect(read.problems).toHaveLength(1);
  expect(read.problems[0]).toStartWith(`${ledger.path}:2: JSON Parse error`);
  expect(read.items.map((item) => item.id)).toEqual([d.id]);
  // And a later write starts on a fresh line, so only the torn line stays damaged.
  ledger.withdraw(d.id, "moot", T0 + 1);
  expect(ledger.read().items[0]?.reason).toBe("moot");
  // And a question with a newline, an escape or U+2028 is refused and writes nothing.
  const before = readFileSync(ledger.path, "utf8");
  for (const question of ["two\nlines", "esc\x1b[31m", "line\u2028sep", "nel\u0085"])
    expect(() => ledger.ask({ question, source: "s:2" }, T0)).toThrow(DecisionError);
  expect(readFileSync(ledger.path, "utf8")).toBe(before);
});

test("an answer notes the open linked worklog item; an unknown or closed --worklog is refused", async () => {
  // Given an open and a closed worklog item.
  const worklog = new Worklog(state.dir);
  const item = worklog.add("Pick a store", "s:1", T0);
  const closed = worklog.add("Old", "s:2", T0);
  worklog.close(closed.id, "done", T0 + 1);
  const invoke = cliIn(state.dir);
  // When asking linked to each.
  const ok = await invoke("decision", "ask", "Which store?", "--source", "s:3", "--worklog", item.id);
  const bad = await invoke("decision", "ask", "Q", "--source", "s:3", "--worklog", closed.id);
  const unknown = await invoke("decision", "ask", "Q", "--source", "s:3", "--worklog", "0000beef");
  // Then only the open link is accepted, each refusal is one line, and nothing else was recorded.
  expect([bad.code, bad.err.trim()]).toEqual([1, `no open worklog item ${closed.id}`]);
  expect([unknown.code, unknown.err.trim()]).toEqual([1, "no open worklog item 0000beef"]);
  const d: { id: string; worklog: string } = JSON.parse(ok.out);
  expect(d.worklog).toBe(item.id);
  expect(new Decisions(state.dir).read().items).toHaveLength(1);
  // And answering it adds a note to the worklog item.
  const answered = await invoke("decision", "answer", d.id, "Postgres", "please", "--source", "s:4");
  expect([answered.code, answered.err]).toEqual([0, ""]);
  expect(new Worklog(state.dir).open()[0]?.notes.map((note) => note.text)).toEqual([
    `decision ${d.id} answered: Postgres please`,
  ]);
});

test("--lane must be a registered lane, and its thread is stored when --thread is absent", async () => {
  // Given a registered lane with a thread.
  await new Registry(state.dir).write({
    key: "store-lane",
    title: "store",
    thread: "discord:c9/1",
    brief: "/b.md",
    done: "file /done.md",
    openedAt: at(0),
  });
  const invoke = cliIn(state.dir);
  // When asking for an unknown lane, for the lane, and for the lane with an explicit thread.
  const unknown = await invoke("decision", "ask", "Q", "--source", "s:1", "--lane", "nope");
  const inherited = JSON.parse((await invoke("decision", "ask", "Q1", "--source", "s:1", "--lane", "store-lane")).out);
  const explicit = await invoke(
    "decision",
    "ask",
    "Q2",
    "--source",
    "s:1",
    "--lane",
    "store-lane",
    "--thread",
    "d:x/2",
  );
  // Then the unknown lane is refused, and the lane's thread fills in only when none is given.
  expect([unknown.code, unknown.err.trim()]).toEqual([1, 'no registered lane "nope"']);
  expect(inherited).toMatchObject({ lane: "store-lane", thread: "discord:c9/1" });
  expect(JSON.parse(explicit.out)).toMatchObject({ lane: "store-lane", thread: "d:x/2" });
  // A lane launched without a thread is recorded as "none", which is no thread; a spaced reference is refused.
  await new Registry(state.dir).write({
    ...(await new Registry(state.dir).read("store-lane"))!,
    key: "bare",
    thread: "none",
  });
  const bare = JSON.parse((await invoke("decision", "ask", "Q3", "--source", "s:1", "--lane", "bare")).out);
  expect(bare.thread).toBeUndefined();
  expect((await invoke("decision", "ask", "Q4", "--source", "s:1", "--thread", "a b")).code).toBe(1);
});

test("digest prints one line per open decision with numbered options and the recommendation marked", async () => {
  // Given an open decision with options, one without, and a withdrawn one.
  const ledger = new Decisions(state.dir);
  const now = Date.now();
  const a = ledger.ask(
    { question: "Which store?", source: "s:1", lane: "store-lane", options: ["Postgres", "SQLite"], recommend: 2 },
    now - 3 * 3_600_000 - 60_000,
  );
  const b = ledger.ask({ question: "Rename the bot?", source: "s:2" }, now);
  const gone = ledger.ask({ question: "Moot?", source: "s:3" }, now);
  ledger.withdraw(gone.id, "decided under delegation", now);
  // When printing the digest.
  const result = await cliIn(state.dir)("decision", "digest");
  // Then only the open ones print, oldest first, with the age in whole hours.
  expect([result.code, result.err]).toEqual([0, ""]);
  expect(result.out.trim().split("\n")).toEqual([
    `${a.id} 3h lane=store-lane kind=owner Which store? | 1) Postgres | 2) SQLite (recommended)`,
    `${b.id} 0h lane=- kind=owner Rename the bot?`,
  ]);
  expect(existsSync(join(state.dir, "decisions.md"))).toBe(false);
});

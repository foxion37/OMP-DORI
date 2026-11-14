import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lessons } from "../src/lessons.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

const T0 = Date.parse("2026-10-29T00:00:00Z");

test("CLI add/list/mark survives separate processes and rejects invalid outcomes", async () => {
  // Given a registered closed lane: lessons can be recorded after close too.
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    await new Registry(state.dir).write({
      key: "qa-lessons",
      title: "QA",
      thread: "none",
      brief: "/brief.md",
      done: "/done.md",
      cwd: state.dir,
      openedAt: new Date(T0).toISOString(),
      closedAt: new Date(T0).toISOString(),
    });
    const invoke = (...args: string[]) =>
      run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
    // When separate CLI invocations add and mark a persisted record.
    const added = await invoke(
      "lesson",
      "add",
      "qa-lessons",
      "--rule",
      "Use event subscriptions",
      "--evidence",
      "/tmp/evidence",
    );
    expect(added.code).toBe(0);
    const stored = new Lessons(state.dir).read().lessons[0];
    if (!stored) throw new Error("CLI did not persist the lesson");
    expect(JSON.parse(added.out)).toEqual(stored);
    const marked = await invoke("lesson", "mark", stored.id, "--outcome", "helped");
    // Then returned JSON, reloaded JSONL and filtered CLI listing agree.
    expect(marked.code).toBe(0);
    expect(JSON.parse(marked.out)).toEqual({ ...stored, outcome: "helped" });
    const listed = await invoke("lesson", "list", "--cwd", state.dir);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out)).toEqual([{ ...stored, outcome: "helped" }]);
    const before = readFileSync(new Lessons(state.dir).path, "utf8");
    expect((await invoke("lesson", "mark", stored.id, "--outcome", "typo")).code).toBe(1);
    expect((await invoke("lesson", "add", "qa-lessons", "--evidence", "/tmp/evidence")).code).toBe(1);
    expect(readFileSync(new Lessons(state.dir).path, "utf8")).toBe(before);
  } finally {
    state.done();
  }
});

test("CLI list and launch --dry-run name a damaged line, keep going, and write nothing", async () => {
  // Given a journal with one lesson for the default cwd and a damaged line after it.
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const journal = new Lessons(state.dir);
    journal.add(
      { lane: "qa-lessons", cwd: state.dir, rule: "Loop flaky UI tests 50 times", evidence: "/tmp/evidence" },
      T0,
    );
    writeFileSync(journal.path, `${readFileSync(journal.path, "utf8")}not-json\n`);
    const before = readFileSync(journal.path, "utf8");
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Do the work.");
    const invoke = (...args: string[]) =>
      run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
    // When listing and previewing a launch.
    const listed = await invoke("lesson", "list");
    const preview = await invoke(
      "launch",
      "qa-new",
      "--title",
      "QA",
      "--brief",
      brief,
      "--done",
      "merged acme/app#1",
      "--dry-run",
    );
    // Then both succeed with the valid lesson, warn with the line number, and change no file.
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).map((l: { rule: string }) => l.rule)).toEqual(["Loop flaky UI tests 50 times"]);
    expect(listed.err).toContain(`LESSON_WARNING ${journal.path}:2: `);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("## Lessons for this repo\n- [pending; qa-lessons] Loop flaky UI tests 50 times");
    expect(preview.err).toContain(`LESSON_WARNING ${journal.path}:2: `);
    expect(readFileSync(brief, "utf8")).toBe("Do the work.");
    expect(readFileSync(journal.path, "utf8")).toBe(before);
    expect(existsSync(join(state.dir, "lanes"))).toBe(false);
  } finally {
    state.done();
  }
});

test("launch preview ships twelve standing rules plus repo lessons and names every over-cap rule", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    const journal = new Lessons(state.dir);
    const globals = Array.from({ length: 13 }, (_, i) =>
      journal.add(
        { lane: "lead", scope: "global", rule: `Global standing rule ${i}`, evidence: `/evidence/global-${i}` },
        T0 + i,
      ),
    );
    const repo = Array.from({ length: 10 }, (_, i) =>
      journal.add(
        { lane: "qa-lessons", cwd: state.dir, rule: `Repo rule ${i}`, evidence: `/evidence/repo-${i}` },
        T0 + 100 + i,
      ),
    );
    journal.mark(globals[1]!.id, "helped");
    const retired = journal.add(
      { lane: "lead", scope: "global", rule: "Retired global rule", evidence: "/evidence/retired" },
      T0 + 1000,
    );
    journal.mark(retired.id, "encoded");
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Keep the owner's original task.");
    const before = readFileSync(journal.path, "utf8");
    const preview = await run([
      "env",
      `DORI_CONFIG=${config}`,
      `DORI_STATE_DIR=${state.dir}`,
      process.execPath,
      cli,
      "launch",
      "qa-new",
      "--title",
      "QA",
      "--brief",
      brief,
      "--done",
      "merged acme/app#1",
      "--dry-run",
    ]);
    expect(preview.code).toBe(0);
    for (const lesson of [...globals.slice(-12), ...repo.slice(-8)]) {
      expect(preview.out).toContain(`] ${lesson.rule}\n`);
    }
    for (const lesson of [globals[0]!, repo[0]!, repo[1]!, retired]) {
      expect(preview.out).not.toContain(lesson.rule);
    }
    expect(preview.err.split("\n")).toEqual([
      `LESSON_OMITTED ${globals[0]!.id} (global) ${globals[0]!.rule}`,
      `LESSON_OMITTED ${repo[1]!.id} (${repo[1]!.cwd}) ${repo[1]!.rule}`,
      `LESSON_OMITTED ${repo[0]!.id} (${repo[0]!.cwd}) ${repo[0]!.rule}`,
    ]);
    expect(preview.out).toContain("Keep the owner's original task.");
    expect(readFileSync(brief, "utf8")).toBe("Keep the owner's original task.");
    expect(readFileSync(journal.path, "utf8")).toBe(before);
    expect(existsSync(join(state.dir, "lanes"))).toBe(false);
  } finally {
    state.done();
  }
});

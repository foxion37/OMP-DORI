import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import { review } from "../src/gate.ts";
import { prompt, type Deps } from "../src/harness.ts";
import { ConfigError, hooksSettled, loadHooks, runHook, substitute } from "../src/hooks.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { World } from "./fake.ts";
import { LEAD, setup } from "./harness-setup.ts";

const config = (d: Deps, value: unknown) => writeFileSync(join(d.store.root, "config.json"), JSON.stringify(value));
const hookCalls = (w: World, cmd: string) => w.calls.filter((c) => c.cmd === cmd).map((c) => [c.cmd, ...c.argv]);

function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  delete process.env["CATALY_PROMPTS_DIR"];
});

describe("hook config and placeholders", () => {
  test("placeholders are substituted per element; spaces and $( stay literal; unknown braces are kept", () => {
    const argv = substitute(["my-hook", "{key}", "--text={text}", "{evidence}", "{other}", "{pr}"], {
      key: "k",
      text: "two words $(rm -rf /) `x`",
      evidence: "a b",
    });
    expect(argv).toEqual(["my-hook", "k", "--text=two words $(rm -rf /) `x`", "a b", "{other}", "{pr}"]);
  });

  test("absent file or absent hooks key = no hooks; other keys are tolerated", () => {
    const { d } = setup();
    expect(loadHooks(d.store.root)).toEqual({});
    config(d, { defaultModel: "x/y", hooks: { onReady: ["x", "{key}"], unrelated: 1 } });
    expect(loadHooks(d.store.root)).toEqual({ onReady: ["x", "{key}"] });
  });

  test("a non-array or a non-string element is a ConfigError naming the key", async () => {
    const { w, d } = setup();
    config(d, { hooks: { onReady: "not-an-array" } });
    expect(() => loadHooks(d.store.root)).toThrow(ConfigError);
    expect(() => loadHooks(d.store.root)).toThrow("hooks.onReady");
    config(d, { hooks: { reviewCommand: ["rev", 7] } });
    expect(() => loadHooks(d.store.root)).toThrow("hooks.reviewCommand");
    await expect(review(d, "o/r#1")).rejects.toThrow(ConfigError);
    expect(w.calls.some((c) => c.cmd === "gh")).toBe(false);
    config(d, { hooks: [] });
    expect(() => loadHooks(d.store.root)).toThrow("hooks must be an object");
  });
});

describe("lifecycle hooks", () => {
  test("onReport runs after the record is saved, with the exact argv", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    config(d, { hooks: { onReport: ["my-hook", "report", "{key}", "{text}"] } });
    await report(d, "lane-k", "half way $(there)", { status: "waiting" });
    await hooksSettled();
    expect(hookCalls(w, "my-hook")).toEqual([["my-hook", "report", "lane-k", "half way $(there)"]]);
    expect(d.store.lane("lane-k")!.status).toBe("waiting");
  });

  test("onReady runs after the lead delivery, with the exact argv", async () => {
    const { w, d, lead, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    config(d, { hooks: { onReady: ["my-hook", "ready", "{key}", "{text}", "{evidence}"] } });
    await ready(d, "lane-k", "final answer", ["https://x/pull/1", "receipt.txt"]);
    await hooksSettled();
    expect(lead.received.at(-1)).toStartWith("[READY lane-k] final answer");
    expect(hookCalls(w, "my-hook")).toEqual([
      ["my-hook", "ready", "lane-k", "final answer", "https://x/pull/1 receipt.txt"],
    ]);
    const hookAt = w.calls.findIndex((c) => c.cmd === "my-hook");
    const leadAt = w.calls.findLastIndex((c) => c.cmd === "deliver" && c.argv[0] === LEAD);
    expect(leadAt).toBeLessThan(hookAt);
  });

  test("onLost runs when the duty loop records a lost lane", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "gone-lane", brief, { group: "w1" });
    config(d, { hooks: { onLost: ["my-hook", "lost", "{key}", "{text}"] } });
    w.panes.delete(lane.sessionRef.id);
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lost" });
    await hooksSettled();
    expect(hookCalls(w, "my-hook")).toEqual([["my-hook", "lost", "gone-lane", "pane disappeared without READY"]]);
    expect(d.store.lane("gone-lane")!.status).toBe("lost");
  });

  test("a hook exiting 1 leaves `cataly ready` exit 0 and prints one stderr line", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    config(d, { hooks: { onReady: ["my-hook", "{key}"] } });
    w.reviewer = () => ({ code: 1, stdout: "", stderr: "boom: webhook refused\nsecond line" });
    const err = captureStderr();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["ready", "lane-k", "--text", "done", "--evidence", "e.txt"], d)).toBe(0);
      await hooksSettled();
    } finally {
      err.restore();
      log.mockRestore();
    }
    expect(err.lines).toEqual(["cataly: hook onReady failed (boom: webhook refused)\n"]);
    expect(d.store.lane("lane-k")!.status).toBe("ready");
  });

  test("a thrown spawn error and a broken config are one stderr line each, never a throw", async () => {
    const { w, d } = setup();
    config(d, { hooks: { onLost: ["no-such-binary"] } });
    const exec = w.exec;
    const failing: Deps = {
      ...d,
      exec: async (cmd, argv) =>
        cmd === "no-such-binary" ? Promise.reject(new Error("ENOENT: spawn\nmore")) : exec(cmd, argv),
    };
    const err = captureStderr();
    try {
      await runHook(failing, "onLost", { key: "k" });
      config(d, { hooks: { onLost: "x" } });
      await runHook(failing, "onLost", { key: "k" });
    } finally {
      err.restore();
    }
    expect(err.lines).toHaveLength(2);
    expect(err.lines[0]).toBe("cataly: hook onLost failed (ENOENT: spawn)\n");
    expect(err.lines[1]).toStartWith("cataly: hook onLost failed (config.json: hooks.onLost must be");
  });
});

describe("reviewCommand and CATALY_PROMPTS_DIR", () => {
  const head = "b".repeat(40);

  test("reviewCommand replaces the built-in reviewer; its VERDICT is parsed and the receipt says model hook", async () => {
    const { w, d } = setup();
    w.gh = (argv) =>
      argv[1] === "view" ? { code: 0, stdout: JSON.stringify({ headRefOid: head }) } : { code: 1, stdout: "" };
    config(d, { hooks: { reviewCommand: ["my-reviewer", "{repo}", "{number}", "{sha}", "{pr}"] } });
    w.reviewer = () => ({ code: 0, stdout: "looked\nVERDICT: BLOCK\nVERDICT: CLEAR" });
    expect(await review(d, "o/r#5", "ignored/model")).toEqual({ verdict: "CLEAR", sha: head });
    expect(hookCalls(w, "my-reviewer")).toEqual([["my-reviewer", "o/r", "5", head, "o/r#5"]]);
    expect(w.calls.some((c) => c.cmd === "omo")).toBe(false);
    expect(d.store.receipt("o/r#5", head)).toMatchObject({ verdict: "CLEAR", model: "hook" });
    w.reviewer = () => ({ code: 0, stdout: "no verdict here" });
    await expect(review(d, "o/r#5")).rejects.toThrow("reviewer printed no VERDICT line");
  });

  test("CATALY_PROMPTS_DIR overrides prompt() and the prompts cataly up renders", async () => {
    const w = new World();
    const d = w.deps();
    const dir = mkdtempSync(join(tmpdir(), "cataly-prompts-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nudge.md"), "custom nudge for {{key}}");
    for (const name of ["lead.md", "duty.md"]) writeFileSync(join(dir, name), `custom ${name} via {{cataly}}`);
    expect(prompt("nudge.md", { key: "k" })).not.toBe("custom nudge for k");
    process.env["CATALY_PROMPTS_DIR"] = dir;
    expect(prompt("nudge.md", { key: "k" })).toBe("custom nudge for k");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await up(d, d.store.root);
    } finally {
      log.mockRestore();
    }
    // Each native role gets its own owner-only prompt file, `<role>.md.<uuid>.md`.
    const rendered = (role: string) => {
      const name = readdirSync(join(d.store.root, "prompts")).find((f) => f.startsWith(`${role}.md.`))!;
      return readFileSync(join(d.store.root, "prompts", name), "utf8");
    };
    expect(rendered("lead")).toStartWith("custom lead.md via cataly");
    expect(rendered("duty")).toStartWith("custom duty.md via cataly");
    expect(d.store.roles().lead).toBeDefined();
  });
});

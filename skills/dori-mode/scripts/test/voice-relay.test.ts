import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PASTE_SETTLE_MS } from "../../../../src/runtime/herdr/deliver.ts";
import type { PaneState } from "../src/lane-state.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";
import { leadRepliesPath } from "../src/voice/relay.ts";
import type { VoiceSettings } from "../src/voice/settings.ts";
import { voiceTools } from "../src/voice/tools.ts";
import type { ToolResult } from "../src/voice/types.ts";
import { agentIn, depsFor, fakeRunner, laneState, newWorld, sent, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const LEAD = "w1:p1";
const RULE = "─".repeat(20);
const IDLE_SCREEN = `previous answer\n${RULE}\n❯ \n${RULE}\n~/repo opus\n`;
const BUSY_SCREEN = `Working (esc to interrupt)\n${RULE}\n❯ \n${RULE}\n`;
const GUARD = "never approves risky work: run no deploy, deletion, payment, production or server change";
const OLD_RECORDS = [
  { type: "session", id: "s1" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "[VOICE] old [voice-request:x]" }] } },
];
const record = (role: "user" | "assistant", text: string) => ({
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});
const settings = { textChannelId: "123456789012345678" } as VoiceSettings;

let state: ReturnType<typeof withState>;
let world: ReturnType<typeof newWorld>;
let sleeps: number[];
let sessionFile: string;
/** Runs after each call the fake herdr answers, so a test can move the lead on at a chosen step. */
let after: (argv: readonly string[]) => void;
/** Answers a call in place of the fake world (a failing herdr step), or undefined to let the world answer. */
let answer: (argv: readonly string[]) => Ran | undefined;

type Lead = {
  status?: string;
  screen?: string;
  foreground?: string;
  pane?: Partial<PaneState> | null;
  leadPane?: string;
};

const tool = (lead: Lead = {}) => {
  world.panes = [
    {
      pane_id: LEAD,
      workspace_id: "w1",
      agent: "omp",
      agent_status: lead.status ?? "idle",
      foreground: lead.foreground ?? "omp",
    },
  ];
  world.screen = lead.screen ?? (lead.status === "working" ? BUSY_SCREEN : IDLE_SCREEN);
  agentIn(world, LEAD);
  if (lead.pane !== null) laneState(state.dir, LEAD, { role: "dori", sessionFile, ...lead.pane });
  const clock: Clock = { now: () => T0, sleep: async (ms) => void sleeps.push(ms) };
  const base = depsFor(world, clock, state.dir, { leadPane: lead.leadPane ?? LEAD });
  const inner = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    const forced = answer(argv);
    if (forced) world.calls.push([...argv]);
    const result = forced ?? (await inner(argv, opts));
    after(argv);
    return result;
  };
  const discord = new Discord(async () => ({ status: 500, headers: {}, body: "" }), clock, "token");
  return (args: unknown): Promise<ToolResult> =>
    voiceTools({ ...base, run }, discord, settings)("forward_to_lead", args);
};
const requestId = (text: string): string => /\[voice-request:([0-9a-f-]{36})\]$/.exec(text)?.[1] ?? "";
const append = (record: unknown): void => appendFileSync(sessionFile, `${JSON.stringify(record)}\n`);
const typed = () =>
  world.calls.filter((c) => c[0] === "herdr" && (c[2] === "send-text" || c[2] === "send-keys" || c[1] === "agent"));
/** No hidden background retry: after every queued task has run, nothing more was called or waited for. */
const quietAfter = async (): Promise<void> => {
  const [calls, waits] = [world.calls.length, sleeps.length];
  const flushed = Promise.withResolvers<void>();
  setImmediate(flushed.resolve);
  await flushed.promise;
  expect([world.calls.length, sleeps.length]).toEqual([calls, waits]);
};

beforeEach(() => {
  state = withState();
  world = newWorld();
  sleeps = [];
  after = () => {};
  answer = () => undefined;
  sessionFile = join(state.dir, "lead-session.jsonl");
  writeFileSync(sessionFile, OLD_RECORDS.map((r) => `${JSON.stringify(r)}\n`).join(""));
});
afterEach(() => state.done());

// A native Windows reply path contains backslashes, so the relay stops before probing or sending.
const posix = test.skipIf(process.platform === "win32");

posix.each(["previous answer", "approved: all checks passed", "allowed operation finished", "승인 완료", "허용됨"])(
  "ordinary prior output is not an approval prompt: %s",
  async (previous) => {
    world.onEnterStatus = "working";
    world.onSendText = (_pane, text) => append(record("user", text));
    const r = await tool({ screen: `${previous}\n${IDLE_SCREEN}` })({
      message: "정리해 줘 `rm -rf $HOME` \\ 끝",
      risky: false,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toStartWith("confirmed-delivered:");
    const [text = ""] = sent(world);
    expect(sent(world)).toHaveLength(1);
    expect(text).toStartWith("[VOICE] 정리해 줘 rm -rf HOME 끝 -- ");
    expect(text).toContain(GUARD);
    expect(text).not.toContain("RISKY");
    expect(text).not.toMatch(/[`$\\]/);
    expect(text).toContain(`to ${leadRepliesPath(state.dir)}; re is a short summary of this request`);
    expect(r.result).toContain(requestId(text));
    // Only herdr's paste settle slept: the receipt was seen without waiting.
    expect(sleeps).toEqual([PASTE_SETTLE_MS]);
  },
);

posix("a risky request is labelled and still carries the written-confirmation guard", async () => {
  world.onEnterStatus = "working";
  world.onSendText = (_pane, text) => append(record("user", text));
  expect((await tool()({ message: "배포해", risky: true })).ok).toBe(true);
  expect(sent(world)[0]).toStartWith("[VOICE] (RISKY request, voice never approves it) 배포해 -- ");
  expect(sent(world)[0]).toContain(GUARD);
});

posix.each(["idle", "working"])("a %s lead needs a new request-bound user record", async (status) => {
  world.onSendText = (_pane, text) => append(record("user", text));
  const r = await tool({ status })({ message: "레인 정리", risky: false });
  expect(r).toMatchObject({ ok: true });
  expect(r.result).toStartWith("confirmed-delivered:");
  expect(r.result).toContain("user record");
  expect(sleeps).toEqual([PASTE_SETTLE_MS]);
});

posix.each(["idle", "working"])("unrelated activity by a %s lead is unconfirmed and never resent", async (status) => {
  world.onSendText = (_pane, text) => {
    append(record("assistant", text));
    append(record("user", "some other input [voice-request:x]"));
    world.panes[0]!.agent_status = "working";
    world.screen = BUSY_SCREEN;
  };
  const r = await tool({ status })({ message: "레인 정리", risky: false });
  expect(r.ok).toBe(false);
  expect(r.result).toStartWith("sent-but-unconfirmed:");
  expect(r.result).toContain("will not be resent");
  expect(r.result).not.toContain("confirmed-delivered");
  expect(sent(world)).toHaveLength(1);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(1);
  // Immediate first look, then 4 short waits, then 250 ms ones, about 10 s in all.
  const waits = sleeps.slice(1);
  expect(waits.slice(0, 4)).toEqual([100, 100, 100, 100]);
  expect(waits.slice(4).every((ms) => ms === 250)).toBe(true);
  expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  await quietAfter();
});

posix("a session file replaced by another session is not receipt, and the watch stops", async () => {
  world.onSendText = (_pane, text) => {
    const other = join(state.dir, "other.jsonl");
    writeFileSync(other, `${JSON.stringify(record("user", text))}\n`);
    renameSync(other, sessionFile);
  };
  const r = await tool({ status: "working" })({ message: "레인 정리", risky: false });
  expect(r.result).toStartWith("sent-but-unconfirmed:");
  expect(sleeps).toEqual([PASTE_SETTLE_MS]);
});

posix.each(["sessionId", "pid"])("a new user receipt does not confirm after the lead %s changes", async (identity) => {
  world.onEnterStatus = "working";
  world.onSendText = (_pane, text) => {
    world.screen = BUSY_SCREEN;
    append(record("user", text));
  };
  after = (argv) => {
    if (argv[2] !== "send-keys") return;
    if (identity === "pid") agentIn(world, LEAD, 5252);
    laneState(state.dir, LEAD, {
      role: "dori",
      sessionFile,
      [identity]: identity === "pid" ? 5252 : "01a11440-0000-7000-8000-000000000000",
    });
  };
  // Even a real new receipt in the original file is not enough after the process or session changes.
  const r = await tool()({ message: "레인 정리", risky: false });
  expect(r.ok).toBe(false);
  expect(r.result).toStartWith("sent-but-unconfirmed:");
  expect(sent(world)).toHaveLength(1);
});

posix.each(["idle", "working"])("a %s lead without a session file is unconfirmed", async (status) => {
  const pane = { sessionFile: join(state.dir, "missing.jsonl") };
  const r = await tool({ status, pane })({ message: "레인 정리", risky: false });
  expect(r.result).toStartWith("sent-but-unconfirmed:");
  expect(sleeps).toEqual([PASTE_SETTLE_MS]);
});

posix("a send that failed partway is sent-but-unconfirmed and is never typed again", async () => {
  world.onEnterStatus = "working";
  // A timeout may come after herdr handed the prompt over: ambiguous, so no typed fallback and no second attempt.
  answer = (argv) =>
    argv[1] === "agent" && argv[2] === "prompt" ? { code: 1, out: "", err: "request timed out" } : undefined;
  const r = await tool()({ message: "레인 정리", risky: false });
  expect(r.ok).toBe(false);
  expect(r.result).toStartWith("sent-but-unconfirmed:");
  expect(r.result).toContain("failed partway");
  expect(world.calls.filter((c) => c[1] === "agent")).toHaveLength(1);
  expect(sent(world)).toHaveLength(0);
  expect(sleeps).toEqual([]);
  await quietAfter();
});

const draftScreen = `${RULE}\n❯ half typed\n${RULE}\n`;
const questionScreen = `Do you want to proceed? (y/n)\n${IDLE_SCREEN}`;
const refusals: readonly [string, Lead, unknown, string, platform?: "posix" | "win32"][] = [
  ["a shell in front", { foreground: "-zsh" }, undefined, "a shell is in front", "posix"],
  ["a pending approval", { pane: { approvalPending: true } }, undefined, "approval is pending", "posix"],
  ["a draft in the input", { screen: draftScreen }, undefined, "input box is not empty", "posix"],
  ["an open question", { screen: questionScreen }, undefined, "prompt is open", "posix"],
  ["no live OMP writer", { pane: null }, undefined, "the lead session is unknown", "posix"],
  ["no lead pane", { leadPane: "" }, undefined, "no lead session is configured"],
  ["an empty message", {}, { message: " `$\\ ", risky: false }, "the message is empty"],
  ["a non-boolean risky", {}, { message: "배포", risky: "no" }, "invalid forward_to_lead arguments"],
  ["no arguments", {}, "not json", "invalid forward_to_lead arguments"],
  ["a Windows reply path", {}, undefined, "the lead reply path contains shell metacharacters", "win32"],
];

for (const [name, lead, args, why, platform] of refusals) {
  const check = platform === "posix" ? posix : test.skipIf(platform === "win32" && process.platform !== "win32");
  check(`${name}: not-sent, nothing typed, no hidden retry`, async () => {
    world.onEnterStatus = "working";
    const r = await tool(lead)(args ?? { message: "레인 정리", risky: false });
    expect(r.ok).toBe(false);
    expect(r.result).toStartWith("not-sent:");
    expect(r.result).toContain(why);
    expect(r.result).toContain("no retry is scheduled");
    expect(typed()).toHaveLength(0);
    if (platform === "win32") expect(world.calls).toEqual([]);
    await quietAfter();
  });
}

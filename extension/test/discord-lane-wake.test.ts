import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { discordWakePendingEpoch } from "../../skills/cataly-mode/scripts/src/discord-lane-wake-pending.ts";
import { readPaneState } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import {
  type DiscordLaneInbox,
  openDiscordLaneInbox,
} from "../../skills/cataly-mode/scripts/src/messenger/discord-lane-inbox.ts";
import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import { type FakePi, load, until, useConfig } from "./fake-pi.ts";

const posix = test.skipIf(process.platform === "win32");

const pane = "5002";
const session = "exact-discord-wake";
const channel = "900000000000000101";
const plain = "900000000000000102";
const input = "900000000000000103";
const next = "900000000000000104";
const identity = { owner: "900000000000000105", bot: "900000000000000106" };
const model = { provider: "fixture-provider", id: "attested-model" };
const active = { status: "active", objective: "finish the work" };
const paused = { ...active, status: "paused" };
const answer = {
  role: "assistant",
  stopReason: "stop",
  timestamp: 20,
  content: [{ type: "text", text: "the native answer" }],
};

async function withWakeLane(
  scenario: {
    readonly pending?: boolean;
    readonly model?: typeof model;
    readonly explicitPause?: boolean;
    readonly registryPaused?: boolean;
  },
  run: (cataly: FakePi, inbox: DiscordLaneInbox, stateDir: string) => Promise<void>,
): Promise<void> {
  const env = {
    CATALY_CONFIG: process.env.CATALY_CONFIG,
    CATALY_STATE_DIR: process.env.CATALY_STATE_DIR,
    CATALY_HEADLESS_ID: process.env.CATALY_HEADLESS_ID,
    TERN_PANE: process.env.TERN_PANE,
    CATALY_DISCORD_WAKE_SESSION: process.env.CATALY_DISCORD_WAKE_SESSION,
    CATALY_DISCORD_WAKE_GOAL: process.env.CATALY_DISCORD_WAKE_GOAL,
    CATALY_DISCORD_WAKE_MODEL: process.env.CATALY_DISCORD_WAKE_MODEL,
  };
  const stateDir = useConfig();
  process.env.TERN_PANE = pane;
  delete process.env.CATALY_HEADLESS_ID;
  process.env.CATALY_DISCORD_WAKE_SESSION = session;
  process.env.CATALY_DISCORD_WAKE_GOAL = "active";
  process.env.CATALY_DISCORD_WAKE_MODEL = `${model.provider}/${model.id}`;
  const inbox = openDiscordLaneInbox(stateDir);
  let cataly: FakePi | undefined;
  try {
    await new Registry(stateDir).create({
      key: "discord-lane",
      title: "Discord lane",
      thread: `discord:${channel}`,
      sessionRef: { id: pane, runtime: "tern" },
      session,
      lifecycleEpoch: scenario.pending ? discordWakePendingEpoch("launch") : "launch",
      ...(scenario.registryPaused && { status: "paused" }),
      brief: "",
      done: "",
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    for (const message of [plain, input, next]) {
      inbox.add(
        session,
        { channel, message, reference: null, text: "same body", replyTo: null, attachments: [] },
        message === plain ? undefined : { reply: identity },
      );
    }
    cataly = await load({
      mode: "tui",
      session: {
        id: session,
        entries: [
          { id: "role", type: "custom", customType: "omp-cataly:role", data: "lane" },
          { id: "saved-active", type: "mode_change", mode: "goal", data: { goal: active } },
        ],
      },
      model: scenario.model ?? model,
    });
    await cataly.emit("session_start");
    cataly.session.entries.push({ id: "cold-pause", type: "mode_change", mode: "goal_paused", data: { goal: paused } });
    await cataly.emit("goal_updated", { goal: paused, state: { enabled: false } });
    if (scenario.explicitPause) {
      cataly.session.entries.push({
        id: "explicit-pause",
        type: "mode_change",
        mode: "goal_paused",
        data: { goal: paused },
      });
      await cataly.emit("goal_updated", { goal: paused, state: { enabled: false } });
    }
    await run(cataly, inbox, stateDir);
  } finally {
    await cataly?.emit("session_shutdown");
    inbox.close();
    rmSync(dirname(stateDir), { force: true, recursive: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

posix.each([false, true])(
  "a cold native pause admits only the opted-in snowflake (native rejection: %s)",
  async (reject) => {
    await withWakeLane({}, async (cataly, inbox, stateDir) => {
      cataly.api.sendUserMessage = async (content) => {
        cataly.userMessages.push(content);
        await cataly.emit("before_agent_start", { reason: "prompt", prompt: content, systemPrompt: [] });
        await cataly.emit("agent_start");
        const user = { role: "user", content: [{ type: "text", text: content }], timestamp: 10 };
        cataly.session.entries.push(
          { id: "discord-input", type: "message", message: user },
          { id: "discord-answer", type: "message", message: answer },
        );
        await cataly.emit("agent_end", { messages: [user, answer] });
        if (reject) throw new Error("sensitive-native-rejection-detail");
      };

      await until(() => (reject ? cataly.notes.length > 0 : inbox.nextReply(session, channel) !== null));

      expect(cataly.userMessages).toEqual([
        `[discord] INBOUND discord ${channel} ${input} from=owner ref=- "same body"`,
      ]);
      expect(cataly.messages).toEqual([]);
      expect(readPaneState(stateDir, pane)?.goal.status).toBe("paused");
      expect(inbox.next(session, channel)?.id).toBe(plain);
      expect(inbox.next(session, channel, { optedInOnly: true })?.id).toBe(next);
      expect(inbox.nextReply(session, channel)).toEqual(
        reject ? null : { id: input, part: 0, text: "the native answer" },
      );
      if (reject) {
        expect(cataly.notes.join(" ")).toContain("input was held");
        expect(cataly.notes.join(" ")).not.toContain("sensitive-native-rejection-detail");
      }
    });
  },
);

posix.each([
  ["the wake reservation is pending", { pending: true }],
  ["the lane registry is paused", { registryPaused: true }],
  ["the native model differs", { model: { ...model, id: "unattested-model" } }],
  ["a later explicit pause supersedes the startup pause", { explicitPause: true }],
] as const)("keeps the opted-in Discord input queued when %s", async (_label, scenario) => {
  await withWakeLane(scenario, async (cataly, inbox) => {
    // Observe the first real intake timer; every registry dependency in that poll reads synchronously.
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    expect(cataly.userMessages).toEqual([]);
    expect(inbox.next(session, channel, { optedInOnly: true })?.id).toBe(input);
  });
});

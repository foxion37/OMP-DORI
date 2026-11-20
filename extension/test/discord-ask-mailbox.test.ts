import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDiscordAskMailbox,
  routeDiscordAskReply,
  routeUnreferencedDiscordAskText,
} from "../../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";

const owner = "109867692300000001";
const channel = "109867692300000002";
const question = "109867692300000003";
const message = "109867692300000004";

const posix = test.skipIf(process.platform === "win32");

posix("only an owner reply to the exact question and channel leaves a durable answer", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  const input = { channel, reference: question, message, text: "the answer" };
  try {
    expect(routeDiscordAskReply(root, input, owner)).toBe(false);
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    try {
      expect(routeDiscordAskReply(root, { ...input, reference: null }, owner)).toBe(false);
      expect(routeDiscordAskReply(root, { ...input, reference: channel }, owner)).toBe(false);
      expect(routeDiscordAskReply(root, { ...input, channel: owner }, owner)).toBe(false);
      expect(routeDiscordAskReply(root, input, channel)).toBe(false);
      expect(mailbox.replies(new Set())).toEqual([]);
      expect(routeDiscordAskReply(root, input, owner)).toBe(true);
      expect(routeDiscordAskReply(root, { ...input, text: "replayed under the same ID" }, owner)).toBe(true);
      expect(mailbox.replies(new Set())).toEqual([{ id: message, text: "the answer" }]);
      expect(mailbox.replies(new Set([message]))).toEqual([]);
    } finally {
      mailbox.close();
    }
    expect(routeDiscordAskReply(root, { ...input, message: "109867692300000005" }, owner)).toBe(true);
    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

const freshId = (offset = 10_000) => (BigInt(Date.now() + offset - 1420070400000) << 22n).toString();
const plainMessage = { channel, message: freshId(), text: "  a novel answer\nwith a second line  " };

posix("plain owner text is opt-in and delivers the original body once to the exact channel", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    const otherChannel = openDiscordAskMailbox(root, owner, question, owner);
    otherChannel.refreshTextIntake();

    expect(routeUnreferencedDiscordAskText(root, plainMessage, owner)).toBe(false);
    mailbox.refreshTextIntake();
    expect(routeDiscordAskReply(root, { ...plainMessage, reference: null }, owner)).toBe(false);
    expect(routeDiscordAskReply(root, { ...plainMessage, reference: channel }, owner)).toBe(false);
    // A fresh receiver process can claim it without sharing publisher state in memory.
    const source = join(import.meta.dir, "../../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts");
    const result = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { routeUnreferencedDiscordAskText } from ${JSON.stringify(source)};
       const [root, input, owner] = process.argv.slice(-3);
       if (!routeUnreferencedDiscordAskText(root, JSON.parse(input), owner)) process.exitCode = 1;`,
      root,
      JSON.stringify(plainMessage),
      owner,
    ]);
    expect(result.exitCode).toBe(0);
    expect(routeUnreferencedDiscordAskText(root, { ...plainMessage, text: "replay" }, owner)).toBe(true);

    expect(mailbox.replies(new Set())).toEqual([{ id: plainMessage.message, text: plainMessage.text, plain: true }]);
    expect(otherChannel.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix.each([
  ["a different owner", plainMessage, channel],
  ["a different channel", { ...plainMessage, channel: owner }, owner],
  ["an older message", { ...plainMessage, message: channel }, owner],
  ["the question itself", { ...plainMessage, message: question }, owner],
  ["a message after the placeholder, but before the prompt", { ...plainMessage, message: freshId(-10_000) }, owner],
  ["whitespace only", { ...plainMessage, text: " \n " }, owner],
] as const)("plain routing leaves %s unclaimed", (_case, input, author) => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    mailbox.refreshTextIntake();

    expect(routeUnreferencedDiscordAskText(root, input, author)).toBe(false);

    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix("plain text is not claimed when two fresh questions could receive it", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const first = openDiscordAskMailbox(root, channel, question, owner);
    const second = openDiscordAskMailbox(root, channel, message, owner);
    first.refreshTextIntake();
    second.refreshTextIntake();

    const input = { ...plainMessage, message: freshId() };
    expect(routeUnreferencedDiscordAskText(root, input, owner)).toBe(false);
    second.close();
    expect(routeUnreferencedDiscordAskText(root, input, owner)).toBe(false);

    expect(first.replies(new Set())).toEqual([]);
    expect(second.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

posix("plain text is not claimed after the publisher stops refreshing", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  const start = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    mailbox.refreshTextIntake();
    clock.mockReturnValue(start + 60_000);

    expect(routeUnreferencedDiscordAskText(root, plainMessage, owner)).toBe(false);

    expect(mailbox.replies(new Set())).toEqual([]);
  } finally {
    clock.mockRestore();
    rmSync(root, { recursive: true });
  }
});

posix("closing rejects novel text and keeps a claimed message from leaking to another question on replay", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-ask-mailbox-"));
  try {
    const mailbox = openDiscordAskMailbox(root, channel, question, owner);
    mailbox.refreshTextIntake();
    const input = { ...plainMessage, message: freshId() };
    expect(routeUnreferencedDiscordAskText(root, input, owner)).toBe(true);
    mailbox.close();
    expect(mailbox.replies(new Set())).toEqual([]);

    const novel = { ...input, message: freshId(20_000) };
    expect(routeUnreferencedDiscordAskText(root, novel, owner)).toBe(false);
    const next = openDiscordAskMailbox(root, channel, message, owner);
    next.refreshTextIntake();
    expect(routeUnreferencedDiscordAskText(root, input, owner)).toBe(true);

    expect(next.replies(new Set())).toEqual([]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

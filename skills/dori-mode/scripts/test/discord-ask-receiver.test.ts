import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discordAskReceivers, openDiscordAskReceiver } from "../src/messenger/discord-ask-receiver.ts";
import { withState } from "./fakes.ts";

// Publication requires a directory whose mode has no group or other bits, which Windows cannot represent.
const posix = test.skipIf(process.platform === "win32");
const TOKEN = "synthetic-receiver-secret";
const receiptPath = (root: string) => {
  const names = readdirSync(root).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  return join(root, names[0]!);
};

posix("receiver discovery binds the exact token, owner and validated channel scope without settings", () => {
  const state = withState();
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20", "20"], () => ["20", "21", "21"]);
  try {
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([{ owner: "10", explicit: ["20"], watched: ["20", "21"] }]);
    for (const wrong of ["", "another-token", `${TOKEN} `, ` ${TOKEN}`])
      expect(discordAskReceivers(state.dir, wrong)).toEqual([]);
    expect(discordAskReceivers(state.dir, TOKEN)).toHaveLength(1);
    expect(existsSync(join(state.dir, "config.json"))).toBe(false);
  } finally {
    receiver.close();
    state.done();
  }
});

posix("scope-all discovery is watched scope, never an implicit Dori destination", () => {
  const state = withState();
  let channels = ["20", "21"];
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", [], () => channels);
  try {
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([{ owner: "10", explicit: [], watched: ["20", "21"] }]);
    channels = ["21", "22"];
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([{ owner: "10", explicit: [], watched: ["21", "22"] }]);
  } finally {
    receiver.close();
    state.done();
  }
});

posix("receipts contain only a SHA-256 token digest and use private files/directories without config rewrites", () => {
  const state = withState();
  const config = join(state.dir, "config.json");
  const settings = '{ "hooks": {}, "discordAsk": { "enabled": false } }\n';
  writeFileSync(config, settings, { mode: 0o600 });
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20"], () => ["20"]);
  try {
    receiver.refresh();
    const root = join(state.dir, "discord-ask-receivers");
    const path = receiptPath(root);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw).tokenDigest).toBe(createHash("sha256").update(TOKEN).digest("hex"));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toHaveLength(1);
    expect(readFileSync(config, "utf8")).toBe(settings);
  } finally {
    receiver.close();
    state.done();
  }
});

posix("expiry ignores stale receipts; refresh renews and close/suspend revoke immediately", () => {
  const state = withState();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20"], () => ["20"]);
  try {
    receiver.refresh();
    const path = receiptPath(join(state.dir, "discord-ask-receivers"));
    expect(JSON.parse(readFileSync(path, "utf8")).expiresAt).toBe(now + 30_000);
    now += 10_000;
    receiver.refresh();
    expect(JSON.parse(readFileSync(path, "utf8")).expiresAt).toBe(now + 30_000);
    now += 30_000;
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toHaveLength(1);
    receiver.suspend();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    receiver.refresh();
    receiver.close();
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  } finally {
    receiver.close();
    clock.mockRestore();
    state.done();
  }
});

posix("a stalled REST receiver expires even though its process is still alive", () => {
  const state = withState();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20"], () => ["20"], 18_000.8);
  try {
    receiver.refresh();
    const path = receiptPath(join(state.dir, "discord-ask-receivers"));
    expect(JSON.parse(readFileSync(path, "utf8")).expiresAt).toBe(now + 18_000);
    expect(discordAskReceivers(state.dir, TOKEN)).toHaveLength(1);
    now += 18_001;
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toHaveLength(1);
  } finally {
    receiver.close();
    clock.mockRestore();
    state.done();
  }
});

posix("PID reuse, exited processes and implausibly future receipts never resolve", () => {
  const state = withState();
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20"], () => ["20"]);
  try {
    receiver.refresh();
    const root = join(state.dir, "discord-ask-receivers");
    const path = receiptPath(root);
    const body = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...body, start: `${body.start}-reused` }));
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    receiver.refresh();
    writeFileSync(path, JSON.stringify({ ...body, expiresAt: Date.now() + 60_000 }));
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    const dead = join(root, "2147483647-00000000-0000-0000-0000-000000000000.json");
    writeFileSync(dead, JSON.stringify({ ...body, pid: 2147483647 }), { mode: 0o600 });
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(dead)).toBe(false);
  } finally {
    receiver.close();
    state.done();
  }
});

posix("only bounded private regular receipts and a private non-symlink directory are trusted", () => {
  const state = withState();
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20"], () => ["20"]);
  try {
    receiver.refresh();
    const root = join(state.dir, "discord-ask-receivers");
    const path = receiptPath(root);
    const raw = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    chmodSync(path, 0o600);
    chmodSync(root, 0o755);
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(() => receiver.refresh()).not.toThrow();
    chmodSync(root, 0o700);
    writeFileSync(path, "x".repeat(65_537));
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    rmSync(path);
    const target = join(state.dir, "unrelated.json");
    writeFileSync(target, raw, { mode: 0o600 });
    symlinkSync(target, path);
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    receiver.suspend();
    expect(readFileSync(target, "utf8")).toBe(raw);
    rmSync(root, { recursive: true });
    const elsewhere = join(state.dir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, root);
    expect(() => receiver.refresh()).not.toThrow();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
  } finally {
    receiver.close();
    state.done();
  }
});

posix("malformed owner/channel receipts are ignored and incomplete explicit scope is not advertised", () => {
  const state = withState();
  let channels = ["20", "21"];
  const receiver = openDiscordAskReceiver(state.dir, TOKEN, "10", ["20", "21"], () => channels);
  try {
    receiver.refresh();
    const path = receiptPath(join(state.dir, "discord-ask-receivers"));
    const body = JSON.parse(readFileSync(path, "utf8"));
    for (const patch of [{ owner: "0" }, { watched: ["bad"] }, { explicit: ["22"] }, { version: 2 }]) {
      writeFileSync(path, JSON.stringify({ ...body, ...patch }));
      expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    }
    writeFileSync(path, "{");
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    channels = ["20"];
    receiver.refresh();
    expect(discordAskReceivers(state.dir, TOKEN)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  } finally {
    receiver.close();
    state.done();
  }
});

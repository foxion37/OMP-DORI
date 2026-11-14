import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discordInboundEnv, fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { withState } from "./fakes.ts";

test("Discord IDs remain lossless decimal strings and malformed environment values fail before use", () => {
  expect(discordInboundEnv("DORI_DISCORD_OWNER_ID", " 900719925474099301 ")).toBe("900719925474099301");
  for (const value of [undefined, "", " ", "0", "-1", "1e3", "0x20", "3.14", "01", "18446744073709551616"]) {
    expect(() => discordInboundEnv("DORI_DISCORD_OWNER_ID", value)).toThrow("DORI_DISCORD_OWNER_ID");
  }
});

test("per-channel cursors persist atomically in owned private files without temporary remnants", () => {
  const state = withState();
  try {
    const store = fileDiscordInboundStore(state.dir, "20");
    const root = join(state.dir, "discord-inbound");
    const path = join(root, "20.json");
    expect(store.load()).toBeUndefined();
    store.save("0");
    expect(store.load()).toBe("0");
    store.save("900719925474099301");
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("900719925474099301");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      channelId: "20",
      cursor: "900719925474099301",
    });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("POSIX user identity is required for cursor ownership checks");
    expect(statSync(path).uid).toBe(uid);
    expect(readdirSync(root)).toEqual(["20.json"]);
    const other = fileDiscordInboundStore(state.dir, "21");
    expect(other.load()).toBeUndefined();
    other.save("22");
    expect(store.load()).toBe("900719925474099301");
    expect(other.load()).toBe("22");
    const previous = readFileSync(path, "utf8");
    expect(() => store.save("../other")).toThrow("cursor is invalid");
    expect(readFileSync(path, "utf8")).toBe(previous);
  } finally {
    state.done();
  }
});

test("a corrupt or mismatched cursor stops intake instead of resetting and replaying history", () => {
  const state = withState();
  try {
    const store = fileDiscordInboundStore(state.dir, "20");
    const path = join(state.dir, "discord-inbound", "20.json");
    for (const text of [
      "private corrupt state body",
      JSON.stringify({ version: 2, channelId: "20", cursor: "100" }),
      JSON.stringify({ version: 1, channelId: "21", cursor: "100" }),
      JSON.stringify({ version: 1, channelId: "20", cursor: "1e9" }),
    ]) {
      writeFileSync(path, text, { mode: 0o600 });
      expect(() => store.load()).toThrow("cursor state is invalid");
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  } finally {
    state.done();
  }
});

test("publicly accessible cursor directories and files are rejected without changing their contents or modes", () => {
  const state = withState();
  try {
    const root = join(state.dir, "discord-inbound");
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    expect(() => fileDiscordInboundStore(state.dir, "20")).toThrow("directory must be private");
    expect(statSync(root).mode & 0o777).toBe(0o755);
    chmodSync(root, 0o700);
    const store = fileDiscordInboundStore(state.dir, "20");
    const path = join(root, "20.json");
    writeFileSync(path, '{"private":"existing"}', { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => store.load()).toThrow("private regular file");
    expect(() => store.save("100")).toThrow("private regular file");
    expect(readFileSync(path, "utf8")).toBe('{"private":"existing"}');
    expect(statSync(path).mode & 0o777).toBe(0o644);
  } finally {
    state.done();
  }
});

test("cursor symlinks and hardlinks neither read nor replace an unrelated file", () => {
  for (const hardlink of [false, true]) {
    const state = withState();
    try {
      const store = fileDiscordInboundStore(state.dir, "20");
      const path = join(state.dir, "discord-inbound", "20.json");
      const target = join(state.dir, "canary");
      writeFileSync(target, "canary remains unchanged", { mode: 0o600 });
      if (hardlink) linkSync(target, path);
      else symlinkSync(target, path);
      expect(() => store.load()).toThrow("private regular file");
      expect(() => store.save("100")).toThrow("private regular file");
      expect(readFileSync(target, "utf8")).toBe("canary remains unchanged");
      if (!hardlink) expect(readlinkSync(path)).toBe(target);
    } finally {
      state.done();
    }
  }
});

test("a symlink cursor directory is rejected and an interrupted private temporary file never becomes the cursor", () => {
  const state = withState();
  try {
    const target = join(state.dir, "other");
    mkdirSync(target, { mode: 0o700 });
    const linkedState = join(state.dir, "linked-state");
    mkdirSync(linkedState, { mode: 0o700 });
    symlinkSync(target, join(linkedState, "discord-inbound"));
    expect(() => fileDiscordInboundStore(linkedState, "20")).toThrow("directory must be private");
    expect(readdirSync(target)).toEqual([]);
    const store = fileDiscordInboundStore(state.dir, "20");
    store.save("100");
    writeFileSync(join(state.dir, "discord-inbound", ".20.interrupted.tmp"), '{"cursor":"999"}', { mode: 0o600 });
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("100");
    store.save("101");
    expect(fileDiscordInboundStore(state.dir, "20").load()).toBe("101");
  } finally {
    state.done();
  }
});

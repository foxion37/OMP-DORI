import { expect, test } from "bun:test";
import { ownerReceiver, watchDave } from "../src/voice/discord-receive.ts";
import { gatewayTimers } from "./discord-presence-fakes.ts";
import { FakeLink, fakeCodec, ids } from "./voice-discord-fakes.ts";

const receiverWorld = () => {
  const { clock, pending, advance } = gatewayTimers();
  const link = new FakeLink(ids.guild, ids.voice, () => ({ sendPayload: () => true, destroy: () => {} }));
  const logs: string[] = [];
  const pcm: Buffer[] = [];
  let codecs = 0;
  const receiver = ownerReceiver({
    ownerId: ids.owner,
    clock,
    codec: () => {
      codecs++;
      return fakeCodec();
    },
    onPcm: (chunk) => pcm.push(chunk),
    log: (line) => logs.push(line),
  });
  return { receiver, link, logs, pcm, pending, advance, codecs: () => codecs };
};

test("only the owner is received, and only while both the owner and a ready link are present", () => {
  const w = receiverWorld();
  w.receiver.presence(true);
  expect(w.link.streams).toHaveLength(0);
  w.receiver.attach(w.link);
  expect([...w.link.subscriptions.keys()]).toEqual([ids.owner]);
  const stream = w.link.streams[0]!;
  stream.push(Buffer.from([7]));
  stream.push(Buffer.from([0xff])); // corrupt: skipped without ending the stream
  stream.push(Buffer.from([9]));
  expect(w.pcm.map((chunk) => [chunk.length, chunk[0]])).toEqual([
    [3840, 7],
    [3840, 9],
  ]);
  expect(w.pending.size).toBe(1); // the stall alarm
  w.receiver.presence(false);
  expect(stream.destroyed).toBe(true);
  expect(w.link.subscriptions.size).toBe(0);
  expect(w.pending.size).toBe(0);
  w.advance(60_000);
  expect(w.link.streams).toHaveLength(1);
  expect(w.logs).toEqual([]);
});

test("a stream the library kills is resubscribed with a bounded backoff that resets after a healthy stream", () => {
  const w = receiverWorld();
  w.receiver.presence(true);
  w.receiver.attach(w.link);
  w.link.streams[0]!.fail("Failed to parse packet");
  expect(w.logs).toEqual(["OWNER STREAM ERROR Failed to parse packet", "OWNER STREAM closed; resubscribing in 100 ms"]);
  w.advance(99);
  expect(w.link.subscribed(ids.owner)).toBe(false);
  w.advance(1);
  expect(w.link.streams).toHaveLength(2);
  const delays: (string | undefined)[] = [];
  for (let i = 0; i < 6; i++) {
    w.link.streams.at(-1)!.destroy();
    delays.push(w.logs.at(-1));
    w.advance(2_000);
  }
  const expected = [200, 400, 800, 1600, 2000, 2000];
  expect(delays).toEqual(expected.map((ms) => `OWNER STREAM closed; resubscribing in ${ms} ms`));
  w.advance(10_001);
  w.link.streams.at(-1)!.destroy();
  expect(w.logs.at(-1)).toBe("OWNER STREAM closed; resubscribing in 0 ms");
  w.advance(0);
  expect(w.link.streams).toHaveLength(9);
  expect(w.codecs()).toBe(9);
});

test("leaving or losing the link during a pending resubscribe cancels it", () => {
  for (const leave of ["presence", "link", "stop"] as const) {
    const w = receiverWorld();
    w.receiver.presence(true);
    w.receiver.attach(w.link);
    w.link.streams[0]!.destroy();
    expect(w.pending.size).toBe(2);
    if (leave === "presence") w.receiver.presence(false);
    else if (leave === "link") w.receiver.attach(undefined);
    else w.receiver.stop();
    expect(w.pending.size).toBe(0);
    w.advance(60_000);
    expect(w.link.streams).toHaveLength(1);
  }
});

test("the stall alarm reports a speaking owner with no decoded audio at most every 10 s, replacing the stream", () => {
  const w = receiverWorld();
  w.receiver.presence(true);
  w.receiver.attach(w.link);
  const stalled = w.link.streams[0]!;
  stalled.push(Buffer.from([1]));
  w.link.speakingUsers.add(ids.owner);
  w.advance(3_000);
  expect(w.logs).toEqual([]);
  w.advance(1_000);
  // Still registered but silent: destroyed, then replaced through the same close path as a stream the library kills.
  expect(w.logs).toEqual([
    "RECEIVE STALL: owner speaking but no audio decoded for 4s; subscribed true",
    "OWNER STREAM closed; resubscribing in 100 ms",
  ]);
  expect(stalled.destroyed).toBe(true);
  w.advance(100);
  const replacement = w.link.streams[1]!;
  expect(w.link.subscriptions.get(ids.owner)).toBe(replacement);
  replacement.push(Buffer.from([2]));
  // The library dropped the subscription without a close: the alarm destroys the orphan and subscribes anew.
  w.link.subscriptions.clear();
  w.advance(10_000);
  expect(w.logs).toHaveLength(2);
  w.advance(900);
  expect(w.logs.slice(2)).toEqual([
    "RECEIVE STALL: owner speaking but no audio decoded for 11s; subscribed false",
    "OWNER STREAM closed; resubscribing in 0 ms",
  ]);
  expect(replacement.destroyed).toBe(true);
  w.advance(0);
  expect(w.link.streams).toHaveLength(3);
  expect(w.link.subscriptions.get(ids.owner)).toBe(w.link.streams[2]);
  w.link.streams[2]!.push(Buffer.from([3]));
  expect(w.pcm.map((chunk) => chunk[0])).toEqual([1, 2, 3]);
  expect(w.codecs()).toBe(3);
  w.receiver.stop();
  expect(w.pending.size).toBe(0);
});

test("a stream whose packets all fail to decode is stalled too", () => {
  const w = receiverWorld();
  w.receiver.presence(true);
  w.receiver.attach(w.link);
  const garbled = w.link.streams[0]!;
  garbled.push(Buffer.from([5]));
  w.link.speakingUsers.add(ids.owner);
  for (let i = 0; i < 4; i++) {
    w.advance(1_000);
    garbled.push(Buffer.from([0xff])); // packets keep arriving, but none decodes
  }
  expect(w.logs).toEqual([
    "RECEIVE STALL: owner speaking but no audio decoded for 4s; subscribed true",
    "OWNER STREAM closed; resubscribing in 100 ms",
  ]);
  expect(garbled.destroyed).toBe(true);
  w.advance(100);
  w.link.streams[1]!.push(Buffer.from([6]));
  expect(w.pcm.map((chunk) => chunk[0])).toEqual([5, 6]);
  w.receiver.stop();
  expect(w.pending.size).toBe(0);
});

test("DAVE renews a finite passthrough window after each MLS change and reports decrypt failures per burst", () => {
  const { clock, pending, advance } = gatewayTimers();
  const link = new FakeLink(ids.guild, ids.voice, () => ({ sendPayload: () => true, destroy: () => {} }));
  const logs: string[] = [];
  let present = false;
  const dave = watchDave(link, { ownerId: ids.owner, ownerPresent: () => present, clock, log: (l) => logs.push(l) });
  link.debug("[DAVE] Session initialized for protocol version 1");
  advance(0);
  expect(link.passthrough).toEqual([]); // no session yet: nothing to open
  link.withDave();
  present = true;
  link.debug("[NW] heartbeat");
  link.debug("[DAVE] MLS commit processed (transition id: 3)");
  link.debug("[DAVE] MLS welcome processed (transition id: 3)");
  advance(0);
  expect(link.passthrough).toEqual([
    [true, 30],
    [false, 30],
  ]);
  expect(logs).toEqual([
    "DAVE Session initialized for protocol version 1",
    "DAVE MLS commit processed (transition id: 3)",
    "DAVE MLS welcome processed (transition id: 3)",
    "DAVE passthrough window 30s; owner decryptor passthrough = true",
  ]);
  for (let i = 1; i <= 3; i++) link.debug(`[DAVE] Failed to decrypt a packet (${i} consecutive fails)`);
  advance(999);
  link.debug("[DAVE] Failed to decrypt a packet (4 consecutive fails)");
  advance(999);
  expect(logs).toHaveLength(4);
  advance(1);
  expect(logs.at(-1)).toBe("DAVE decrypt failure burst: 4 packets dropped");
  link.daveFails = true;
  link.debug("[DAVE] Transition executed (transition id: 4)");
  advance(0);
  expect(logs.at(-1)).toBe("DAVE passthrough failed session not ready");
  link.debug("[DAVE] Failed to decrypt a packet (1 consecutive fails)");
  link.debug("[DAVE] Session reinitialized for protocol version 1");
  dave.stop();
  expect(logs.slice(-2)).toEqual([
    "DAVE Session reinitialized for protocol version 1",
    "DAVE decrypt failure burst: 1 packets dropped",
  ]);
  expect(pending.size).toBe(0);
  link.debug("[DAVE] MLS commit processed (transition id: 5)");
  expect(logs).toHaveLength(9);
  expect(pending.size).toBe(0);
});

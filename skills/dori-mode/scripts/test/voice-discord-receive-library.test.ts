/**
 * The owner receiver against the receive contract of @discordjs/voice 0.19 instead of the synchronous fake:
 * VoiceReceiver.subscribe() hands back the registered stream while one exists, and a destroyed stream stays registered
 * until its close, which Node streams emit a tick after destroy(). A replacement that does not wait for that close is
 * handed the dead stream back.
 */
import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { OwnerStream, ReceiveLink } from "../src/voice/discord-link.ts";
import { ownerReceiver } from "../src/voice/discord-receive.ts";
import { settle } from "./discord-inbound-live-fakes.ts";
import { gatewayTimers } from "./discord-presence-fakes.ts";
import { fakeCodec, ids } from "./voice-discord-fakes.ts";

/** VoiceReceiver.subscribe and onUdpMessage over real Readables, wrapped per receive() call as discord.ts does. */
class LibraryLink implements ReceiveLink {
  readonly registered = new Map<string, Readable>();
  readonly created: Readable[] = [];
  readonly speakingUsers = new Set<string>();
  subscribed(userId: string) {
    return this.registered.has(userId);
  }
  speaking(userId: string) {
    return this.speakingUsers.has(userId);
  }
  receive(userId: string): OwnerStream {
    let stream = this.registered.get(userId);
    if (!stream) {
      const created = new Readable({ objectMode: true, read: () => {} });
      created.once("close", () => this.registered.delete(userId));
      this.registered.set(userId, created);
      this.created.push(created);
      stream = created;
    }
    const current = stream;
    return {
      onData: (cb) => {
        current.on("data", cb);
      },
      onError: (cb) => {
        current.on("error", (error: Error) => cb(error.message));
      },
      onClose: (cb) => {
        current.on("close", cb);
      },
      destroy: () => {
        current.destroy();
      },
    };
  }
  /** An owner packet, pushed to whichever stream is registered, as onUdpMessage does. */
  packet(userId: string, opus: number) {
    this.registered.get(userId)?.push(Buffer.from([opus]));
  }
}

const world = () => {
  const { clock, pending, advance } = gatewayTimers();
  const link = new LibraryLink();
  const logs: string[] = [];
  const pcm: number[] = [];
  const receiver = ownerReceiver({
    ownerId: ids.owner,
    clock,
    codec: fakeCodec,
    onPcm: (chunk) => pcm.push(chunk[0]!),
    log: (line) => logs.push(line),
  });
  receiver.presence(true);
  receiver.attach(link);
  return { receiver, link, logs, pcm, pending, advance };
};

const STALL = "RECEIVE STALL: owner speaking but no audio decoded for 4s; subscribed true";
const speech = Array.from({ length: 12 }, (_, i) => i + 1);

/** Twelve seconds of decoded speech, then the registered stream goes quiet while Discord still reports speaking. */
const speakThenStall = async (w: { link: LibraryLink; logs: string[]; advance(ms: number): void }) => {
  w.link.speakingUsers.add(ids.owner);
  for (const opus of speech) {
    w.link.packet(ids.owner, opus);
    await settle();
    w.advance(1_000);
  }
  expect(w.link.created).toHaveLength(1);
  expect(w.logs).toEqual([]);
  w.advance(3_000);
  expect(w.logs).toEqual([STALL]);
};

test("a stream silent while the owner speaks is destroyed, then replaced once the library unregisters it", async () => {
  const w = world();
  await speakThenStall(w);
  const stalled = w.link.created[0]!;
  expect(stalled.destroyed).toBe(true);
  w.link.packet(ids.owner, 99); // still registered until its close: dropped, never decoded
  await settle();
  expect(w.logs).toEqual([STALL, "OWNER STREAM closed; resubscribing in 0 ms"]);
  expect(w.link.registered.size).toBe(0);
  w.advance(0);
  expect(w.link.created).toHaveLength(2);
  expect(w.link.registered.get(ids.owner)).toBe(w.link.created[1]);
  w.link.packet(ids.owner, 42);
  await settle();
  expect(w.pcm).toEqual([...speech, 42]);
  w.receiver.stop();
  await settle();
  expect(w.link.created[1]!.destroyed).toBe(true);
  expect(w.link.registered.size).toBe(0);
  expect(w.pending.size).toBe(0);
});

test("a stream that decodes while the owner speaks, or stays quiet while the owner is silent, is kept", async () => {
  const w = world();
  w.link.speakingUsers.add(ids.owner);
  for (let opus = 1; opus <= 30; opus++) {
    w.link.packet(ids.owner, opus);
    await settle();
    w.advance(1_000);
  }
  w.link.speakingUsers.delete(ids.owner);
  w.advance(60_000);
  expect(w.link.created).toHaveLength(1);
  expect(w.link.created[0]!.destroyed).toBe(false);
  expect(w.pcm).toHaveLength(30);
  expect(w.logs).toEqual([]);
  w.receiver.stop();
  await settle();
});

test("leaving before a stalled stream's close lands cancels its replacement; returning subscribes afresh", async () => {
  for (const leave of ["presence", "link", "stop"] as const) {
    const w = world();
    await speakThenStall(w);
    if (leave === "presence") w.receiver.presence(false);
    else if (leave === "link") w.receiver.attach(undefined);
    else w.receiver.stop();
    await settle(); // the stalled stream's close lands after the owner or the link is gone
    expect(w.link.registered.size).toBe(0);
    expect(w.pending.size).toBe(0);
    w.advance(60_000);
    expect(w.link.created).toHaveLength(1);
    expect(w.logs).toEqual([STALL]);
    if (leave === "stop") continue;
    if (leave === "presence") w.receiver.presence(true);
    else w.receiver.attach(w.link);
    expect(w.link.created).toHaveLength(2);
    w.link.packet(ids.owner, 7);
    await settle();
    expect(w.pcm).toEqual([...speech, 7]);
    w.receiver.stop();
    await settle();
  }
});

test("re-attaching before a destroyed stream's close lands still ends with a stream that decodes", async () => {
  for (const rejoin of ["link", "presence"] as const) {
    const w = world();
    w.link.packet(ids.owner, 1);
    await settle();
    // In one tick: the old stream is destroyed but stays registered until its close, so the library hands it back.
    if (rejoin === "link") {
      w.receiver.attach(undefined);
      w.receiver.attach(w.link);
    } else {
      w.receiver.presence(false);
      w.receiver.presence(true);
    }
    await settle();
    expect(w.logs).toEqual(["OWNER STREAM closed; resubscribing in 100 ms"]);
    w.advance(100);
    expect(w.link.created).toHaveLength(2);
    expect(w.link.registered.get(ids.owner)).toBe(w.link.created[1]);
    w.link.packet(ids.owner, 2);
    await settle();
    expect(w.pcm).toEqual([1, 2]);
    w.receiver.stop();
    await settle();
  }
});

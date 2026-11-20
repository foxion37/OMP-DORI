import { expect, test } from "bun:test";
import { once } from "node:events";
import { downTo24kMono, Playback, paceInput, rmsDbfs } from "../src/voice/audio.ts";
import { playbackSource } from "../src/voice/discord-link.ts";
import { fakeCodec } from "./voice-discord-fakes.ts";

const pcm16 = (...samples: number[]) => {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    out.writeInt16LE(s, i * 2);
  });
  return out;
};
const samples = (pcm: Buffer) => Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2));

test("48 kHz stereo is averaged to 24 kHz mono and a trailing odd frame is dropped", () => {
  // Frames (L,R): (100,300) (500,700) | (-1000,-1000) (-3000,-3000) | (8,8)
  const stereo = pcm16(100, 300, 500, 700, -1000, -1000, -3000, -3000, 8, 8);
  expect(samples(downTo24kMono(stereo))).toEqual([400, -2000]);
  expect(downTo24kMono(Buffer.alloc(0))).toHaveLength(0);
});

test("levels read in dBFS with silence and empty input at -120", () => {
  expect(rmsDbfs(Buffer.alloc(960))).toBe(-120);
  expect(rmsDbfs(Buffer.alloc(0))).toBe(-120);
  expect(rmsDbfs(pcm16(32767, -32768))).toBeCloseTo(0, 3);
  expect(rmsDbfs(pcm16(3277, -3277))).toBeCloseTo(-20, 1);
});

test("playback upsamples with the previous sample carried across writes and reset by clear", () => {
  const p = new Playback();
  let notified = 0;
  p.onReadable = () => notified++;
  p.write(pcm16(100));
  p.write(pcm16(300));
  expect(notified).toBe(2);
  expect(p.read()).toBeNull();
  // 479 more samples complete one 20 ms frame (480 input samples, 3840 bytes) with one sample (8 bytes) left over.
  p.write(Buffer.alloc(479 * 2));
  expect(p.queuedMs()).toBeCloseTo((481 * 8 * 20) / 3840, 6);
  const frame = p.read()!;
  expect(frame).toHaveLength(3840);
  expect(samples(frame.subarray(0, 16))).toEqual([50, 50, 100, 100, 200, 200, 300, 300]);
  expect(samples(frame.subarray(16, 24))).toEqual([150, 150, 0, 0]);
  expect(p.read()).toBeNull();
  p.write(pcm16(400));
  p.clear();
  expect(p.queuedMs()).toBe(0);
  expect(p.read()).toBeNull();
  p.write(pcm16(400));
  p.write(Buffer.alloc(959 * 2));
  expect(samples(p.read()!.subarray(0, 8))).toEqual([200, 200, 400, 400]);
  p.write(Buffer.alloc(1));
  expect(notified).toBe(6);
});

test("a frame is assembled across chunk boundaries in order", () => {
  const p = new Playback();
  const ramp = Array.from({ length: 1200 }, (_, i) => i);
  p.write(pcm16(...ramp.slice(0, 7)));
  p.write(pcm16(...ramp.slice(7)));
  const out = [...samples(p.read()!), ...samples(p.read()!)];
  const held = out.filter((_, i) => i % 4 === 2);
  expect(held).toEqual(ramp.slice(0, held.length));
  expect(held).toHaveLength(960);
  expect(p.queuedMs()).toBeCloseTo(((1200 - 960) * 8 * 20) / 3840, 6);
});

test("the player source waits for data, then emits one encoded frame per whole frame queued", async () => {
  const p = new Playback();
  const source = playbackSource(p, fakeCodec());
  const drain = () => {
    const frames: string[] = [];
    for (let frame: Buffer | null = source.read(); frame; frame = source.read()) frames.push(frame.toString());
    return frames;
  };
  expect(drain()).toEqual([]);
  p.write(pcm16(...Array<number>(1920).fill(1000))); // 80 ms; the first frame starts from the interpolated 500
  expect(drain()).toEqual(["opus:3840:500", "opus:3840:1000", "opus:3840:1000", "opus:3840:1000"]);
  p.write(Buffer.alloc(240 * 2)); // 10 ms: less than a frame stays queued
  expect(drain()).toEqual([]);
  expect(p.queuedMs()).toBe(10);
  const closed = once(source, "close");
  source.destroy();
  await closed;
  expect(p.onReadable).toBeUndefined();
});

test("input pacing starts with a full 3 s bucket, refills at 1.15x and pads only past 100 ms behind", () => {
  const bucket = { tokens: Number.POSITIVE_INFINITY, last: 0 };
  expect(paceInput(bucket, 0, 100_000, 0)).toEqual({ audio: 72_000, silence: 0 });
  expect(bucket.tokens).toBe(0);
  // 24 kHz x 1.15 is 27.6 samples/ms; floating point leaves the floor one sample short.
  expect(paceInput(bucket, 1_000, 100_000, 0)).toEqual({ audio: 27_599, silence: 0 });
  expect(paceInput(bucket, 2_000, 0, 2_400)).toEqual({ audio: 0, silence: 0 });
  expect(paceInput(bucket, 2_000, 0, 2_401)).toEqual({ audio: 0, silence: 2_401 });
  expect(paceInput(bucket, 2_000, 1_000, 30_000)).toEqual({ audio: 1_000, silence: 24_199 });
  expect(bucket.tokens).toBeLessThan(1);
  // A long stall cannot bank more than 3 s.
  expect(paceInput(bucket, 600_000, 1_000_000, 0)).toEqual({ audio: 72_000, silence: 0 });
});

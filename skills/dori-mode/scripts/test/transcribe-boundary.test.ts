import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { defaultConfig } from "../src/config.ts";
import { audioSamples, trackSamples } from "./audio-samples.ts";
import { type DiscordRoute, withDiscordCli } from "./discord-fakes.ts";

const url = "https://cdn.example/audio/voice.ogg?token=private";
const key = "GET /audio/voice.ogg?token=private";
const samples = { ...audioSamples, ...trackSamples, opus: audioSamples.ogg };
const mimes = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  m4a: "audio/mp4",
  flac: "audio/flac",
  freeFormat: "audio/mpeg",
  lateMoov: "audio/mp4",
  vorbis: "video/ogg",
  opusMapped: "audio/opus",
  audioVideoMp4: "video/mp4",
};
const formats = Object.keys(mimes) as (keyof typeof mimes)[];
const refusal = (error: string): void => {
  expect(error).toStartWith("transcribe: ");
  expect(error).toContain("transcribeMaxBytes");
  expect(error).toMatch(/; (convert|correct|provide|use|set|check) /);
  expect(error).not.toContain("\n");
  expect(error).not.toContain("token=private");
};

test("URL transcription defaults to 25 MiB without making local paths a download policy boundary", () => {
  expect(defaultConfig().transcribeMaxBytes).toBe(26214400);
});

test.each(formats)(
  "%s audio identification passes at the exact limit despite absent, zero or understated length",
  async (format) => {
    await withDiscordCli(async (f) => {
      const bytes = Buffer.from(samples[format], "base64");
      for (const [length, mime] of [
        [undefined, mimes[format]],
        ["0", undefined],
        ["1", "application/octet-stream"],
        [String(bytes.length), `${mimes[format].toUpperCase()}; charset=binary`],
      ]) {
        const r = await f.invoke(["transcribe", url], {
          transcribeMaxBytes: bytes.length,
          routes: {
            [key]: {
              base64: samples[format],
              headers: {
                ...(length === undefined ? {} : { "content-length": length }),
                ...(mime === undefined ? {} : { "content-type": mime }),
              },
            },
          },
        });
        expect([r.code, r.err, r.out, r.keys, r.audio.length]).toEqual([
          0,
          "",
          bytes.toString("utf8").trim(),
          [key],
          1,
        ]);
        expect(r.audio[0]!.base64).toBe(samples[format]);
        const modes = process.platform === "win32" ? [0o666, 0o666] : [0o600, 0o700];
        expect([r.audio[0]!.fileMode, r.audio[0]!.dirMode]).toEqual(modes);
        expect(existsSync(r.audio[0]!.file)).toBe(false);
        expect(readdirSync(f.tmp)).toEqual([]);
      }
    });
  },
);

test("split headers stream in order, preserve every byte and abort the completed transfer before the hook", async () => {
  await withDiscordCli(async (f) => {
    const bytes = Buffer.from(audioSamples.ogg, "base64");
    const chunks = [bytes.subarray(0, 5), bytes.subarray(5, 35), bytes.subarray(35)].map((chunk) =>
      chunk.toString("base64"),
    );
    const r = await f.invoke(["transcribe", url], {
      transcribeMaxBytes: bytes.length,
      routes: { [key]: { chunks, headers: { "content-type": "application/ogg" } } },
    });
    expect([r.code, r.err, r.audio.length]).toEqual([0, "", 1]);
    expect(r.audio[0]!.base64).toBe(audioSamples.ogg);
    expect(
      r.requests.filter((request) => request.key === "BODY_READ").map((request) => request.body?.["index"]),
    ).toEqual([0, 1, 2, 3]);
    expect(r.requests.filter((request) => request.key === "BODY_ABORT").map((request) => request.body)).toEqual([
      { index: 3 },
    ]);
    expect(existsSync(r.audio[0]!.file)).toBe(false);
    expect(readdirSync(f.tmp)).toEqual([]);
  });
});

test.each([undefined, "0", "1", "999999"])(
  "size %s never permits a midstream overflow or reads the trailing chunk",
  async (length) => {
    await withDiscordCli(async (f) => {
      const bytes = Buffer.from(audioSamples.ogg, "base64");
      const chunks = [bytes.subarray(0, 12), bytes.subarray(12, 24), Buffer.from("must not be read")].map((chunk) =>
        chunk.toString("base64"),
      );
      const r = await f.invoke(["transcribe", url], {
        transcribeMaxBytes: 20,
        routes: { [key]: { chunks, headers: length === undefined ? {} : { "content-length": length } } },
      });
      expect([r.code, r.out, r.audio, readdirSync(f.tmp)]).toEqual([1, "", [], []]);
      expect(r.err).toContain(length === "999999" ? "declared audio size" : "downloaded audio");
      expect(r.err).toContain("exceeds the limit");
      refusal(r.err);
      expect(
        r.requests.filter((request) => request.key === "BODY_READ").map((request) => request.body?.["index"]),
      ).toEqual(length === "999999" ? [] : [0, 1]);
      expect(r.requests.filter((request) => request.key === "BODY_ABORT").map((request) => request.body)).toEqual([
        { index: length === "999999" ? 0 : 2 },
      ]);
    });
  },
);

const rejected: { name: string; route: DiscordRoute; reason: string }[] = [
  {
    name: "raw PCM",
    route: { base64: Buffer.alloc(64).toString("base64"), headers: { "content-type": "audio/L16" } },
    reason: "unsupported or truncated",
  },
  {
    name: "PDF claiming WAV",
    route: { raw: "%PDF-1.7\nnot audio", headers: { "content-type": "audio/wav" } },
    reason: "unsupported or truncated",
  },
  {
    name: "ID3 metadata without an MPEG frame",
    route: { base64: Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]).toString("base64") },
    reason: "unsupported or truncated",
  },
  {
    name: "HEIC ftyp claiming M4A",
    route: {
      base64: Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0]).toString("base64"),
      headers: { "content-type": "audio/mp4" },
    },
    reason: "unsupported or truncated",
  },
  {
    name: "WAV claiming MPEG",
    route: { base64: audioSamples.wav, headers: { "content-type": "audio/mpeg" } },
    reason: "Content-Type does not match",
  },
  {
    name: "Ogg claiming HTML",
    route: { base64: audioSamples.ogg, headers: { "content-type": "text/html" } },
    reason: "Content-Type does not match",
  },
  {
    name: "Vorbis claiming Opus",
    route: { base64: trackSamples.vorbis, headers: { "content-type": "audio/opus" } },
    reason: "Content-Type does not match",
  },
  {
    name: "Theora Ogg without an audio stream",
    route: { base64: trackSamples.videoOgg, headers: { "content-type": "video/ogg" } },
    reason: "unsupported or truncated",
  },
  {
    name: "video-only MP4 track metadata",
    route: { base64: trackSamples.videoMp4, headers: { "content-type": "video/mp4" } },
    reason: "unsupported or truncated",
  },
  { name: "empty bytes", route: { base64: "" }, reason: "URL audio is empty" },
  { name: "absent body", route: { status: 204 }, reason: "no audio body" },
];

test.each(rejected)(
  "URL input $name is rejected before the hook and leaves no temporary file",
  async ({ route, reason }) => {
    await withDiscordCli(async (f) => {
      const r = await f.invoke(["transcribe", url], { routes: { [key]: route } });
      expect([r.code, r.out, r.audio, r.keys, readdirSync(f.tmp)]).toEqual([1, "", [], [key], []]);
      expect(r.err).toContain(reason);
      refusal(r.err);
    });
  },
);

test("a broken stream aborts and removes its already-written prefix without invoking the hook", async () => {
  await withDiscordCli(async (f) => {
    const bytes = Buffer.from(audioSamples.ogg, "base64");
    const r = await f.invoke(["transcribe", url], {
      routes: {
        [key]: {
          chunks: [bytes.subarray(0, 10).toString("base64"), bytes.subarray(10).toString("base64")],
          streamFailureAfter: 1,
        },
      },
    });
    expect([r.code, r.out, r.audio, readdirSync(f.tmp)]).toEqual([1, "", [], []]);
    expect(r.err).toContain("could not download audio");
    refusal(r.err);
    expect(
      r.requests.filter((request) => request.key === "BODY_READ").map((request) => request.body?.["index"]),
    ).toEqual([0, 1]);
    expect(r.requests.filter((request) => request.key === "BODY_ABORT").map((request) => request.body)).toEqual([
      { index: 1 },
    ]);
  });
});

test.each([0, -1, null, "25", 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "invalid byte policy %s refuses a URL before fetch",
  async (limit) => {
    await withDiscordCli(async (f) => {
      const r = await f.invoke(["transcribe", url], { transcribeMaxBytes: limit });
      expect([r.code, r.out, r.keys, r.audio, readdirSync(f.tmp)]).toEqual([1, "", [], [], []]);
      expect(r.err).toContain("positive safe integer byte count");
      refusal(r.err);
    });
  },
);

test("local raw PCM bypasses URL size/signature rules and retains the exact owned source file", async () => {
  await withDiscordCli(async (f) => {
    const pcm = Buffer.alloc(64);
    writeFileSync(f.local, pcm);
    const before = statSync(f.local);
    const r = await f.invoke(["transcribe", f.local], { transcribeMaxBytes: 1 });
    expect([r.code, r.err, r.out, r.keys, r.audio.length]).toEqual([0, "", pcm.toString("utf8"), [], 1]);
    expect([r.audio[0]!.file, r.audio[0]!.base64]).toEqual([f.local, pcm.toString("base64")]);
    expect(readFileSync(f.local)).toEqual(pcm);
    expect([statSync(f.local).ino, statSync(f.local).mode]).toEqual([before.ino, before.mode]);
    expect(readdirSync(f.tmp)).toEqual([]);
  });
});

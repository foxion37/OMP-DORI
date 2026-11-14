import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { withDiscordCli } from "./discord-fakes.ts";

const audioUrl = "https://cdn.example/audio/voice.ogg?token=private";

test("local and URL transcription use the real hook and remove private downloads on every completion", async () => {
  await withDiscordCli(async (f) => {
    const local = await f.invoke(["transcribe", f.local]);
    expect([local.code, local.out, local.keys, local.audio[0]!.file]).toEqual([0, "local transcript", [], f.local]);
    expect(existsSync(f.local)).toBe(true);
    let previous: string | undefined;
    for (const url of [audioUrl, audioUrl.replace("https:", "http:")]) {
      const r = await f.invoke(["transcribe", url]);
      expect([r.code, r.err, r.out, r.keys]).toEqual([0, "", "audio bytes", ["GET /audio/voice.ogg?token=private"]]);
      const receipt = r.audio[0]!;
      expect([receipt.content, receipt.fileMode, receipt.dirMode]).toEqual(["audio bytes", 0o600, 0o700]);
      expect(dirname(dirname(receipt.file))).toBe(f.tmp);
      expect(receipt.file).not.toBe(previous);
      expect(existsSync(receipt.file)).toBe(false);
      expect(readdirSync(f.tmp)).toEqual([]);
      previous = receipt.file;
    }
    for (const mode of ["fail", "empty"]) {
      const r = await f.invoke(["transcribe", audioUrl], { environment: { DORI_TEST_TRANSCRIBE: mode } });
      expect([r.code, r.out, r.audio.length]).toEqual([1, "", 1]);
      expect(r.err).toContain(`transcription failed (exit ${mode === "fail" ? 7 : 0})`);
      expect(existsSync(r.audio[0]!.file)).toBe(false);
      expect(readdirSync(f.tmp)).toEqual([]);
    }
    const missing = await f.invoke(["transcribe", audioUrl], { hook: null });
    expect([missing.code, missing.err, missing.audio, readdirSync(f.tmp)]).toEqual([
      1,
      "no hooks.transcribe configured",
      [],
      [],
    ]);
    for (const route of [{ status: 404 }, { failure: "fetch" as const }, { failure: "body" as const }]) {
      const r = await f.invoke(["transcribe", audioUrl], { routes: { "GET /audio/voice.ogg?token=private": route } });
      expect([r.code, r.out, r.audio, readdirSync(f.tmp)]).toEqual([1, "", [], []]);
      expect(r.err).toBe(
        route.status === 404 ? "transcribe: GET /audio/voice.ogg answered 404" : "transcribe: could not download audio",
      );
      expect(r.err).not.toContain("token=private");
    }
    const failedLocal = await f.invoke(["transcribe", f.local], { hook: null });
    expect([failedLocal.code, failedLocal.err, existsSync(f.local)]).toEqual([
      1,
      "no hooks.transcribe configured",
      true,
    ]);
  });
}, 60_000);

import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import { installBundle } from "../src/release/install.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { fixture, posix } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

const { readFileSync, readlinkSync, writeFileSync } = fs;

posix("automatic acquisition cannot activate using a configuration changed during its download", async () => {
  const f = fixture();
  const first = f.release("one").bundle;
  const before = await installBundle(
    f.paths,
    { ...first, manifest: { ...first.manifest, prerelease: false } },
    undefined,
  );
  const next = boundRelease(f, "two").bundle;
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  let downloaded = false;
  const source = await automaticUpdate(f.paths, {
    now: 10_000,
    checkTools: () => {},
    acquire: async () => {
      downloaded = true;
      writeFileSync(f.paths.config, text);
      return { ...next, manifest: { ...next.manifest, prerelease: false } };
    },
  });
  expect(downloaded).toBe(true);
  expect(source).toBe(releasePath(f.paths, before.current));
  expect(loadInstalled(f.paths)).toEqual(before);
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(readAutomaticState(f.paths).detail).toContain("Configuration changed during setup");
});

posix("an atomic owner save during setup snapshot holds automatic update without disrupting the release", async () => {
  const f = fixture();
  const before = await installBundle(f.paths, f.release("one").bundle, undefined);
  const current = releasePath(f.paths, before.current);
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  const staged = join(f.paths.cataly, "owner-save.json");
  writeFileSync(staged, text, { mode: 0o600 });
  const original = fs.statSync(f.paths.config, { bigint: true });
  const fsRead = fs.readSync;
  let saved = false;
  const read = spyOn(fs, "readSync").mockImplementation(
    new Proxy(fsRead, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        const file = fs.fstatSync(args[0], { bigint: true });
        if (!saved && file.dev === original.dev && file.ino === original.ino) {
          fs.renameSync(staged, f.paths.config);
          saved = true;
        }
        return result;
      },
    }),
  );
  const checkTools = () => {
    throw new Error("unexpected tool lookup for an attempt held during setup");
  };
  try {
    expect(await automaticUpdate(f.paths, { now: 10_000, checkTools })).toBe(current);
  } finally {
    read.mockRestore();
  }
  expect(readAutomaticState(f.paths)).toMatchObject({
    outcome: "held",
    detail: expect.stringContaining("Configuration changed while being read"),
  });
  expect(readlinkSync(f.paths.live)).toBe(current);
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
});

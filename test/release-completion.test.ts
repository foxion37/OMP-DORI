import { expect } from "bun:test";
import { join, resolve } from "node:path";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import { installBundle } from "../src/release/install.ts";
import { loadInstalled } from "../src/release/state.ts";
import { fixture, posix } from "./release-consumer-setup.ts";
import { boundRelease, releaseDist } from "./release-native-recovery-setup.ts";

posix.each(["manual", "automatic", "unresolved"])(
  "%s install reports committed state after journal cleanup fails",
  async (mode) => {
    const f = fixture(true);
    const before = await installBundle(f.paths, f.release("one").bundle, undefined);
    const bound = boundRelease(f, "two").bundle;
    const manifest = { ...bound.manifest, prerelease: false };
    const candidate = { dist: releaseDist(join(f.root, "candidate-dist"), { ...bound, manifest }) };
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { runConsumerUpdate } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/cli.ts"))};
import { automaticUpdate } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/automatic.ts"))};
import { acquireBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/bundle.ts"))};
import { consumerPaths } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/files.ts"))};
const unlink = fs.unlinkSync;
let failed = false;
spyOn(fs, "unlinkSync").mockImplementation((path) => {
  if (!failed && path === ${JSON.stringify(f.paths.journal)}) {
    failed = true;
    if (${JSON.stringify(mode)} === "unresolved") {
      unlink(${JSON.stringify(f.paths.live)});
      fs.symlinkSync(${JSON.stringify(join(f.paths.releases, `${before.current.commit}-${before.current.source.hash.slice(0, 16)}`))}, ${JSON.stringify(f.paths.live)});
    }
    throw new Error("injected cleanup holds after commit");
  }
  unlink(path);
});
if (${JSON.stringify(mode)} !== "automatic")
  process.exit(await runConsumerUpdate(["install", "--from", ${JSON.stringify(candidate.dist)}, "--home", ${JSON.stringify(f.paths.cataly)}]));
console.log(await automaticUpdate(consumerPaths(${JSON.stringify(f.paths.home)}, ${JSON.stringify(f.paths.cataly)}), {
  acquire: () => acquireBundle({ from: ${JSON.stringify(candidate.dist)} }),
}));
`,
      ],
      { env: { HOME: f.paths.home, PATH: process.env["PATH"] }, timeout: 20_000 },
    );
    expect(loadInstalled(f.paths)?.current.tag).toBe(manifest.tag);
    expect(loadInstalled(f.paths)?.previous).toEqual(before.current);
    if (mode === "manual") {
      expect(result.exitCode, result.stderr.toString()).toBe(3);
      expect(result.stderr.toString()).toContain("install committed; maintenance pending");
      expect(result.stderr.toString()).not.toContain("release held");
    } else if (mode === "automatic") {
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readAutomaticState(f.paths)).toMatchObject({
        outcome: "installed",
        available: manifest.tag,
        detail: "Committed; maintenance pending: injected cleanup holds after commit",
      });
    } else {
      expect(result.exitCode, result.stderr.toString()).toBe(4);
      expect(result.stderr.toString()).toContain("release outcome unresolved");
      expect(result.stderr.toString()).not.toContain("release held");
    }
  },
);

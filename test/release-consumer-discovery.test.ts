import { expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { replacePointer, saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { recoverInstalled, releasePath } from "../src/release/state.ts";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix("isolated discovery follows the active release through interrupted activation and rollback", async () => {
  const f = fixture(true);
  // Each release's own launcher reports the extension and discovery overlay the wrapper selected for it.
  const launcher = `#!${process.execPath}
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const extension = args[args.indexOf("-e") + 1];
const configs = args.flatMap((arg, i) => arg === "--config" ? [args[i + 1]] : []);
const overlay = readFileSync(configs.at(-1), "utf8");
const directory = JSON.parse(overlay.match(/^    - (.+)$/m)[1]);
console.log(JSON.stringify({
  payload: readFileSync(join(dirname(extension), "payload.txt"), "utf8"),
  skill: readFileSync(join(directory, "omp-cataly-mode/SKILL.md"), "utf8")
}));
`;
  const previous = process.env["PATH"];
  try {
    const first = f.release("first\n", launcher);
    const one = await installBundle(f.paths, first.bundle, undefined);
    const second = f.release("second\n", launcher);
    const two = await installBundle(f.paths, second.bundle, one);
    const launch = (marker: string): void => {
      const result = Bun.spawnSync([join(f.paths.cataly, "bin/omp")], {
        env: { HOME: f.paths.home, PATH: previous },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const observed = JSON.parse(result.stdout.toString());
      expect(observed.payload).toBe(`${marker}\n`);
      expect(observed.skill).toContain(marker);
      expect(observed.skill).toContain("name: omp-cataly-mode");
    };
    launch("second");
    replacePointer(f.paths.live, releasePath(f.paths, two.current), releasePath(f.paths, one.current));
    saveJson(f.paths.state, one);
    saveJson(f.paths.journal, { version: 1, before: one, after: two });
    launch("first");
    expect(recoverInstalled(f.paths)).toEqual(one);
    launch("first");
    const reactivated = await installBundle(f.paths, second.bundle, one);
    launch("second");
    await rollbackRelease(f.paths, reactivated, one.current.tag);
    launch("first");
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
});

posix.each(["bytes", "file symlink", "link target", "mode"] as const)(
  "reinstall preserves and rejects modified discovery %s",
  async (change) => {
    const f = fixture(true);
    const native = join(f.root, "native");
    mkdirSync(native);
    writeFileSync(join(native, "omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const previous = process.env["PATH"];
    process.env["PATH"] = `${native}:${previous ?? ""}`;
    try {
      const release = f.release("first\n");
      const installed = await installBundle(f.paths, release.bundle, undefined);
      const skillDir = join(
        f.paths.root,
        "consumer-discovery",
        basename(releasePath(f.paths, installed.current)),
        "skills/omp-cataly-mode",
      );
      const skill = join(skillDir, "SKILL.md");
      const modified = `${readFileSync(skill, "utf8")}owner change\n`;
      const reference = join(skillDir, "references");
      if (change === "bytes") writeFileSync(skill, modified);
      if (change === "file symlink") {
        unlinkSync(skill);
        symlinkSync(join(f.root, "owner-skill"), skill);
      }
      if (change === "link target") {
        unlinkSync(reference);
        symlinkSync(join(f.root, "owner-reference"), reference);
      }
      if (change === "mode") chmodSync(skill, 0o644);
      await expect(installBundle(f.paths, release.bundle, installed)).rejects.toThrow();
      if (change === "bytes") expect(readFileSync(skill, "utf8")).toBe(modified);
      if (change === "file symlink") expect(readlinkSync(skill)).toBe(join(f.root, "owner-skill"));
      if (change === "link target") expect(readlinkSync(reference)).toBe(join(f.root, "owner-reference"));
      if (change === "mode") expect(lstatSync(skill).mode & 0o777).toBe(0o644);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  },
);

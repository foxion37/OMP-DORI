import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import { automaticLaunch, automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { digest } from "../src/update/source.ts";
import { archive, portableFixture as fixture, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix("ordinary source directories are never enrolled or checked by the consumer launcher", async () => {
  const f = fixture();
  expect(await automaticLaunch(f.root, f.paths.home)).toBe(f.root);
  expect(readAutomaticState(f.paths).nextCheck).toBe(0);
});

posix("a candidate without support for the configured host/runtime profile is never activated", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const config = JSON.parse(readFileSync(f.paths.config, "utf8"));
  config.runtime = process.platform === "darwin" ? "herdr" : "hc";
  saveJson(f.paths.config, config);
  const settings = readFileSync(f.paths.config);
  const pointer = readlinkSync(f.paths.live);
  const next = f.release("two").bundle;
  const candidate = { ...next, manifest: { ...next.manifest, prerelease: false } };
  expect(await automaticUpdate(f.paths, { now: 42, acquire: async () => candidate, checkTools: () => {} })).toBe(
    releasePath(f.paths, one.current),
  );
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(readFileSync(f.paths.config)).toEqual(settings);
  expect(readAutomaticState(f.paths)).toMatchObject({
    outcome: "failed",
    detail: "Available release does not support this installation profile",
  });
});

posix("bound automatic activation admits native and ULW bundles without mutating the old release", async () => {
  const f = fixture();
  const first = boundRelease(f, "first");
  const before = await installBundle(f.paths, first.bundle, undefined);
  const second = boundRelease(f, "second", first.source);
  const candidate = { ...second.bundle, manifest: { ...second.bundle.manifest, prerelease: false } };
  const old = releasePath(f.paths, before.current);
  const lock = readFileSync(join(old, "omp-ulw.overlay.lock"));
  const selected = await automaticUpdate(f.paths, { now: 50, acquire: async () => candidate, checkTools: () => {} });
  expect(selected).toBe(releasePath(f.paths, candidate.manifest));
  expect(readFileSync(join(old, "omp-ulw.overlay.lock"))).toEqual(lock);
  expect(readAutomaticState(f.paths).outcome).toBe("installed");
  expect(JSON.parse(readFileSync(join(nativeDirectory(selected, f.paths.home), "native-config.json"), "utf8"))).toEqual(
    { update: { auto: false } },
  );
});

posix("primary consumer shell re-execs the newly selected source before resolving native code", () => {
  const f = fixture();
  const current = join(f.root, "first source");
  const next = join(f.root, "next source");
  const native = join(f.root, "native");
  writeFileSync(native, '#!/bin/sh\nprintf "%s\\n" "new-native" "$@"\n', { mode: 0o755 });
  for (const source of [current, next]) {
    mkdirSync(join(source, "scripts/consumer"), { recursive: true });
    mkdirSync(join(source, "src/release"), { recursive: true });
    copyFileSync(resolve(import.meta.dir, "../scripts/consumer/omp"), join(source, "scripts/consumer/omp"));
    chmodSync(join(source, "scripts/consumer/omp"), 0o755);
    writeFileSync(join(source, "src/release/automatic.ts"), `console.log(${JSON.stringify(next)});\n`);
    writeFileSync(
      join(source, "scripts/source-dependencies.ts"),
      source === next
        ? `console.log(${JSON.stringify(native)});\n`
        : 'throw new Error("stale dependency resolver ran");\n',
    );
  }
  const cwd = join(f.root, "untrusted-cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./injected.ts"]\n');
  writeFileSync(join(cwd, "injected.ts"), 'throw new Error("untrusted preload ran");\n');
  const launched = Bun.spawnSync([join(current, "scripts/consumer/omp"), "--dori-role", "dori", "space argument"], {
    cwd,
    env: { HOME: f.paths.home, PATH: `${dirname(process.execPath)}:${process.env["PATH"]}` },
  });
  expect(launched.exitCode, launched.stderr.toString()).toBe(0);
  expect(launched.stdout.toString().trim().split("\n")).toEqual([
    "new-native",
    "--dori-role",
    "dori",
    "space argument",
  ]);
});

function withAutomatic(bundle: VerifiedBundle, next: string): VerifiedBundle {
  const path = "src/release/automatic.ts";
  const bytes = Buffer.from(`console.log(${JSON.stringify(next)});\n`);
  const files = [...bundle.files, { path, bytes, executable: false }].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const entries = files.map((file) => ({ path: file.path, sha256: digest(file.bytes), executable: file.executable }));
  const source = {
    ...bundle.manifest.source,
    files: entries,
    hash: digest(JSON.stringify({ files: entries, ulwPresent: false })),
  };
  const archiveBytes = archive(
    files.map((file) => ({
      name: `${bundle.manifest.archive.root}/${file.path}`,
      bytes: file.bytes,
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive({ ...bundle.manifest, source }, archiveBytes);
  return { manifest, files: readArchive(archiveBytes, manifest) };
}

posix("isolated launch computes extension and discovery argv from the new source, in an empty cwd", async () => {
  const f = fixture(true);
  const next = f.release("next").bundle;
  const nextSource = releasePath(f.paths, next.manifest);
  const newer = await installBundle(f.paths, next, undefined);
  const current = withAutomatic(f.release("current").bundle, nextSource);
  await installBundle(f.paths, current, newer);
  const native = join(f.root, "native-bin/omp");
  writeFileSync(native, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const cwd = join(f.root, "untrusted-cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./injected.ts"]\n');
  writeFileSync(join(cwd, "injected.ts"), 'throw new Error("untrusted preload ran");\n');
  const launched = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--dori-role", "dori"], {
    cwd,
    env: { HOME: f.paths.home, PATH: process.env["PATH"] },
  });
  expect(launched.exitCode, launched.stderr.toString()).toBe(0);
  const args = launched.stdout.toString().trim().split("\n");
  expect(args).toContain(join(nextSource, "extension"));
  expect(args).toContain(join(f.paths.root, "consumer-discovery", nextSource.split("/").at(-1)!, "omp.yml"));
  expect(args).not.toContain(join(releasePath(f.paths, current.manifest), "extension"));
});

posix("automatic CLI opt-out and resume are durable and leave config bytes untouched", async () => {
  const f = fixture();
  await installBundle(f.paths, f.release("one").bundle, undefined);
  const config = readFileSync(f.paths.config);
  const cli = resolve(import.meta.dir, "../skills/dori-mode/scripts/src/cli.ts");
  for (const mode of ["disable", "status", "enable"] as const) {
    const result = Bun.spawnSync([process.execPath, cli, "update", "auto", mode], {
      env: { HOME: f.paths.home, DORI_HOME: f.paths.dori, PATH: process.env["PATH"] },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()).automatic.enabled).toBe(mode === "enable");
  }
  expect(readFileSync(f.paths.config)).toEqual(config);
});

posix(
  "automatic primary updates preserve custom model roles, thinking and native update settings byte-for-byte",
  async () => {
    const f = fixture();
    await installBundle(f.paths, f.release("one").bundle, undefined);
    const settings = "modelRoles:\n  default: owner/model\ndefaultThinkingLevel: ultra\nupdate:\n  auto: false\n";
    const path = join(f.paths.dori, "omp.yml");
    writeFileSync(path, settings, { mode: 0o600 });
    const candidate = f.release("two").bundle;
    await automaticUpdate(f.paths, {
      now: 60,
      acquire: async () => ({ ...candidate, manifest: { ...candidate.manifest, prerelease: false } }),
      checkTools: () => {},
    });
    expect(readFileSync(path, "utf8")).toBe(settings);
    expect(readAutomaticState(f.paths).outcome).toBe("installed");
  },
);

posix("an owner-edited owned isolated settings file is preserved and fails launch admission closed", async () => {
  const f = fixture(true);
  await installBundle(f.paths, f.release("one").bundle, undefined);
  const path = join(f.paths.dori, "omp.yml");
  const original = readFileSync(path, "utf8");
  expect(original).toContain("update:\n  auto: false\n");
  const settings = `${original}modelRoles:\n  default: owner/model\ndefaultThinkingLevel: ultra\n`;
  writeFileSync(path, settings);
  let downloaded = false;
  await expect(
    automaticUpdate(f.paths, {
      now: 60,
      acquire: async () => {
        downloaded = true;
        return f.release("two").bundle;
      },
      checkTools: () => {},
    }),
  ).rejects.toThrow("Consumer reference changed");
  expect(downloaded).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(settings);
});

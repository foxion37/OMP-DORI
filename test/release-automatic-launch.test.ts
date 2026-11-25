import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import { automaticLaunch, automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { installBundle } from "../src/release/install.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { digest } from "../src/update/source.ts";
import { archive, fixture, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix("ordinary source directories are never enrolled or checked by the consumer launcher", async () => {
  const f = fixture();
  expect(await automaticLaunch(f.root, f.paths.home)).toBe(f.root);
  expect(readAutomaticState(f.paths).nextCheck).toBe(0);
});

posix("a candidate without this host's headless profile is never activated", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const settings = readFileSync(f.paths.config);
  const pointer = readlinkSync(f.paths.live);
  const other =
    process.platform === "linux" ? { platform: "darwin", arch: "arm64" } : { platform: "linux", arch: "x64" };
  const profiles = JSON.stringify({ version: 1, profiles: [{ ...other, runtime: "headless" }] });
  const next = boundRelease(f, "two", undefined, {
    populateSource: (source) => writeFileSync(join(source, "release-headless.json"), profiles),
  }).bundle;
  const candidate = { ...next, manifest: { ...next.manifest, prerelease: false } };
  expect(await automaticUpdate(f.paths, { now: 42, acquire: async () => candidate, checkTools: () => {} })).toBe(
    releasePath(f.paths, one.current),
  );
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(readFileSync(f.paths.config)).toEqual(settings);
  expect(readAutomaticState(f.paths)).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("/headless"),
  });
});

posix("bound automatic activation admits a native bundle without mutating the old release", async () => {
  const f = fixture();
  const first = boundRelease(f, "first");
  const before = await installBundle(f.paths, first.bundle, undefined);
  const second = boundRelease(f, "second", first.source);
  const candidate = { ...second.bundle, manifest: { ...second.bundle.manifest, prerelease: false } };
  const old = releasePath(f.paths, before.current);
  const lock = readFileSync(join(old, "native-omp.lock"));
  const selected = await automaticUpdate(f.paths, { now: 50, acquire: async () => candidate, checkTools: () => {} });
  expect(selected).toBe(releasePath(f.paths, candidate.manifest));
  expect(readFileSync(join(old, "native-omp.lock"))).toEqual(lock);
  expect(readAutomaticState(f.paths).outcome).toBe("installed");
  expect(JSON.parse(readFileSync(join(nativeDirectory(selected, f.paths.home), "native-config.json"), "utf8"))).toEqual(
    { update: { auto: false } },
  );
});

posix("the primary OMP link keeps its physical home across source selection from a foreign cwd", () => {
  const f = fixture();
  const current = join(f.paths.releases, `${"1".repeat(40)}-${"a".repeat(16)}`);
  const next = join(f.paths.releases, `${"2".repeat(40)}-${"b".repeat(16)}`);
  writeFileSync(f.paths.config, '{"selected":"consumer"}\n');
  for (const source of [current, next]) {
    mkdirSync(join(source, "scripts/consumer"), { recursive: true });
    mkdirSync(join(source, "src/release"), { recursive: true });
    copyFileSync(resolve(import.meta.dir, "../scripts/consumer/omp"), join(source, "scripts/consumer/omp"));
    chmodSync(join(source, "scripts/consumer/omp"), 0o755);
    writeFileSync(
      join(source, "src/release/automatic.ts"),
      `console.log(process.env.CATALY_MANAGED_STARTUP ? process.argv[2] : ${JSON.stringify(next)});\n`,
    );
    const native = join(source, "native");
    writeFileSync(
      native,
      `#!/bin/sh\nprintf "%s\\n" ${basename(source)} "$CATALY_HOME" "$CATALY_CONFIG" "\${CATALY_STATE_DIR-state unset}" "$PWD" "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(source, "scripts/source-dependencies.ts"),
      `const config = await Bun.file(process.env.CATALY_CONFIG).json();
if (config.selected !== "consumer") throw new Error("Wrong consumer dependency config");
console.log(${JSON.stringify(native)});\n`,
    );
  }
  const bin = join(f.paths.cataly, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "omp");
  symlinkSync(`../releases/releases/${basename(current)}/scripts/consumer/omp`, wrapper);
  const cwd = join(f.root, "untrusted-cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./injected.ts"]\n');
  writeFileSync(join(cwd, "injected.ts"), 'throw new Error("untrusted preload ran");\n');
  writeFileSync(join(cwd, "readlink"), '#!/bin/sh\nprintf "%s\\n" /untrusted\n', { mode: 0o755 });
  writeFileSync(join(cwd, "config.json"), '{"selected":"foreign"}\n');
  const foreign = { HOME: cwd, CONFIG: join(cwd, "config.json"), STATE_DIR: join(cwd, "state") };
  const own = { HOME: f.paths.cataly, CONFIG: f.paths.config, STATE_DIR: join(f.paths.cataly, "managed-state") };
  for (const [context, managed] of [
    [undefined, undefined],
    [foreign, undefined],
    [own, undefined],
    [undefined, "CATALY"],
    [foreign, "CATALY"],
  ] as const) {
    const inherited: Record<string, string> = Object.fromEntries(
      Object.entries(context ?? {}).map(([key, value]) => [`CATALY_${key}`, value]),
    );
    if (managed) {
      inherited["CATALY_MANAGED_STARTUP"] = "1";
      if (context === undefined) inherited["CATALY_STATE_DIR"] = own.STATE_DIR;
    }
    const launched = Bun.spawnSync([wrapper, "--cataly-role", "lane", "space argument"], {
      cwd,
      env: { ...inherited, HOME: f.paths.home, PATH: `.:${dirname(process.execPath)}:${process.env["PATH"]}` },
    });
    const state = context === own || (context === undefined && managed) ? own.STATE_DIR : "state unset";
    expect(launched.exitCode, launched.stderr.toString()).toBe(0);
    expect(launched.stdout.toString().trim().split("\n")).toEqual([
      basename(managed ? current : next),
      f.paths.cataly,
      f.paths.config,
      state,
      cwd,
      "--cataly-role",
      "lane",
      "space argument",
    ]);
  }
});

/** Replace or add exact release files, rebinding the source manifest and archive. */
function withFiles(
  bundle: VerifiedBundle,
  replaced: Record<string, { bytes: string; executable: boolean }>,
): VerifiedBundle {
  const kept = bundle.files.filter((file) => !Object.hasOwn(replaced, file.path));
  const added = Object.entries(replaced).map(([path, file]) => ({
    path,
    bytes: Buffer.from(file.bytes),
    executable: file.executable,
  }));
  const files = [...kept, ...added].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = files.map((file) => ({ path: file.path, sha256: digest(file.bytes), executable: file.executable }));
  const source = { ...bundle.manifest.source, files: entries, hash: digest(JSON.stringify({ files: entries })) };
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
  // The selected source's own launcher prints the argv the isolated wrapper computed for it.
  const next = withFiles(f.release("next").bundle, {
    "scripts/consumer/omp": { bytes: '#!/bin/sh\nprintf "%s\\n" "$@"\n', executable: true },
  });
  const nextSource = releasePath(f.paths, next.manifest);
  const newer = await installBundle(f.paths, next, undefined);
  const current = withFiles(f.release("current").bundle, {
    "src/release/automatic.ts": { bytes: `console.log(${JSON.stringify(nextSource)});\n`, executable: false },
  });
  await installBundle(f.paths, current, newer);
  const cwd = join(f.root, "untrusted-cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./injected.ts"]\n');
  writeFileSync(join(cwd, "injected.ts"), 'throw new Error("untrusted preload ran");\n');
  const launched = Bun.spawnSync([join(f.paths.cataly, "bin/omp"), "--cataly-role", "lane"], {
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
  const cli = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");
  for (const mode of ["disable", "status", "enable"] as const) {
    const result = Bun.spawnSync([process.execPath, cli, "update", "auto", mode], {
      env: { HOME: f.paths.home, CATALY_HOME: f.paths.cataly, PATH: process.env["PATH"] },
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
    const path = join(f.paths.cataly, "omp.yml");
    writeFileSync(path, settings, { mode: 0o600 });
    const candidate = boundRelease(f, "two").bundle;
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
  const path = join(f.paths.cataly, "omp.yml");
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

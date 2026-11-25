import { expect, test } from "bun:test";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { automaticUpdate } from "../src/release/automatic.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { resolveConsumerOmpCommand } from "../src/release/runtime.ts";
import { releasePath } from "../src/release/state.ts";
import { isPolicyLaneCommand } from "../skills/cataly-mode/scripts/src/lane-policy-launch.ts";
import { fixture } from "./release-consumer-setup.ts";
import { boundRelease, releaseDist } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix(
  "consumer install, update and reuse select each loaded release's bound native source without rewriting config",
  async () => {
    const f = fixture();
    const first = boundRelease(f, "first");
    const one = await installBundle(f.paths, first.bundle, undefined);
    const config = readFileSync(f.paths.config);
    const configured = JSON.parse(config.toString());
    const sourceOne = releasePath(f.paths, one.current);
    const omp = resolveConsumerOmpCommand(["omp", "{prompt}"], { home: f.paths.home, sourceRoot: sourceOne });
    expect(omp[0]).toBe(readlinkSync(join(f.paths.cataly, "bin/omp")));
    expect(omp).toEqual([
      join(sourceOne, "scripts/consumer/omp"),
      "--no-extensions",
      "-e",
      join(sourceOne, "extension"),
      "{prompt}",
    ]);
    expect(configured.agentCommand[0]).toBe(join(f.paths.cataly, "bin/omp"));
    expect(
      isPolicyLaneCommand(
        resolveConsumerOmpCommand([join(f.paths.cataly, "bin/omp"), "--cataly-role", "lane", "{prompt}"], {
          home: f.paths.home,
          sourceRoot: sourceOne,
        }),
      ),
    ).toBe(true);
    const second = boundRelease(f, "second");
    const two = await installBundle(f.paths, second.bundle, one);
    const sourceTwo = releasePath(f.paths, two.current);
    const bound = (sourceRoot: string) =>
      readFileSync(join(nativeDirectory(sourceRoot, f.paths.home), "source/index.ts"));
    expect(readlinkSync(join(f.paths.cataly, "bin/omp"))).toBe(join(sourceTwo, "scripts/consumer/omp"));
    expect(bound(sourceOne).toString()).toContain('selected = "first"');
    expect(bound(sourceTwo).toString()).toContain('selected = "second"');
    expect(await installBundle(f.paths, second.bundle, two)).toEqual(two);
    expect(readFileSync(f.paths.config)).toEqual(config);
    expect(resolveConsumerOmpCommand(["/owner/custom-omp"], { home: f.paths.home, sourceRoot: sourceTwo })).toEqual([
      "/owner/custom-omp",
    ]);
    const rolled = await rollbackRelease(f.paths, two);
    expect(readlinkSync(join(f.paths.cataly, "bin/omp"))).toBe(join(sourceOne, "scripts/consumer/omp"));
    expect(readFileSync(f.paths.config)).toEqual(config);
    writeFileSync(join(nativeDirectory(sourceTwo, f.paths.home), "source/index.ts"), "owner edit\n");
    await expect(installBundle(f.paths, second.bundle, rolled)).rejects.toThrow("source checkout differs");
    expect(readlinkSync(f.paths.live)).toBe(sourceOne);
  },
);

posix.each(["19.0.0", "19.1.2"])(
  "bound OMP %s installs and rolls back to retained 19.0.1 without a stock fallback",
  async (version) => {
    const f = fixture();
    const prior = boundRelease(f, "prior");
    const one = await installBundle(f.paths, prior.bundle, undefined);
    const next = boundRelease(f, "next", undefined, { version });
    const two = await installBundle(f.paths, next.bundle, one);
    expect(two.current.requirements.omp).toBe(version);
    const source = releasePath(f.paths, two.current);
    expect(readlinkSync(join(f.paths.cataly, "bin/omp"))).toBe(join(source, "scripts/consumer/omp"));
    expect(resolveConsumerOmpCommand(["omp"], { home: f.paths.home, sourceRoot: source })[0]).toBe(
      join(source, "scripts/consumer/omp"),
    );
    const rolled = await rollbackRelease(f.paths, two);
    expect(rolled.current.requirements.omp).toBe("19.0.1");
    expect(readlinkSync(join(f.paths.cataly, "bin/omp"))).toBe(
      join(releasePath(f.paths, one.current), "scripts/consumer/omp"),
    );
    expect(rolled.previous).toEqual(two.current);
    expect(readFileSync(join(releasePath(f.paths, two.current), "native-omp.lock"), "utf8")).toContain(
      `"nativeVersion":"${version}"`,
    );
  },
);

posix.each(["20.0.0", "19.0.0-beta.1", "19.01.0", "19.0.0;echo injected"])(
  "unreviewed native runtime %s is rejected",
  (version) => {
    const f = fixture();
    const release = boundRelease(f, "reviewed", undefined, { version: "19.0.0" }).bundle.manifest;
    expect(() => validateReleaseManifest({ ...release, requirements: { omp: version } })).toThrow("supported runtime");
  },
);

const onReleaseHost = test.skipIf(
  !(
    (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "darwin" && process.arch === "arm64")
  ),
);

onReleaseHost.each(["manual", "automatic"] as const)(
  "%s consumer update leaves a release without this host's profile, and rollback to it is refused",
  async (mode) => {
    const f = fixture(true);
    const other =
      process.platform === "linux" ? { platform: "darwin", arch: "arm64" } : { platform: "linux", arch: "x64" };
    const foreign = JSON.stringify({ version: 1, profiles: [{ ...other, runtime: "headless" }] });
    const old = boundRelease(f, "foreign", undefined, {
      populateSource: (source) => writeFileSync(join(source, "release-headless.json"), foreign),
    });
    const oldDist = releaseDist(join(f.root, "dist-foreign"), old.bundle);
    const before = await installBundle(f.paths, old.bundle, undefined);
    const bound = boundRelease(f, "native");
    const candidate = { ...bound, dist: releaseDist(join(f.root, "dist-native"), bound.bundle) };
    const saved = readFileSync(f.paths.config);
    const tools = "/usr/bin:/bin";
    const cli = (...args: string[]) =>
      Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../src/release/cli.ts"), ...args], {
        env: { ...process.env, PATH: tools, CATALY_RUNTIME: "" },
      });
    const check = cli("check", "--from", candidate.dist);
    expect(check.exitCode, check.stderr.toString()).toBe(0);
    if (mode === "manual") {
      const install = cli("install", "--from", candidate.dist);
      expect(install.exitCode, install.stderr.toString()).toBe(0);
    } else {
      const oldPath = process.env["PATH"];
      const previousRuntime = process.env["CATALY_RUNTIME"];
      process.env["PATH"] = tools;
      process.env["CATALY_RUNTIME"] = "";
      try {
        const stable = { ...candidate.bundle, manifest: { ...candidate.bundle.manifest, prerelease: false } };
        expect(await automaticUpdate(f.paths, { now: 10_000, acquire: async () => stable })).toBe(
          releasePath(f.paths, candidate.bundle.manifest),
        );
      } finally {
        if (oldPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = oldPath;
        if (previousRuntime === undefined) delete process.env["CATALY_RUNTIME"];
        else process.env["CATALY_RUNTIME"] = previousRuntime;
      }
    }
    const retained = readlinkSync(f.paths.live);
    expect(retained).toBe(releasePath(f.paths, candidate.bundle.manifest));
    const rollback = cli("rollback", "--version", before.current.tag);
    expect(rollback.exitCode).toBe(2);
    expect(rollback.stderr.toString()).toContain(`does not support ${process.platform}/${process.arch}/headless`);
    const downgrade = cli("install", "--from", oldDist);
    expect(downgrade.exitCode).toBe(2);
    expect(downgrade.stderr.toString()).toContain(`does not support ${process.platform}/${process.arch}/headless`);
    expect(readlinkSync(f.paths.live)).toBe(retained);
    expect(readFileSync(f.paths.config)).toEqual(saved);
  },
);

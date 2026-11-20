import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { recoverInstalled, releasePath } from "../src/release/state.ts";
import { fixture } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix(
  "isolated source releases need no stock OMP and bind both native and ULW defaults to the loaded release",
  async () => {
    const f = fixture(true);
    const tools = join(f.root, "bound-tools");
    mkdirSync(tools, { mode: 0o700 });
    const git = Bun.which("git");
    if (!git) throw new Error("The Git fixture prerequisite is unavailable");
    symlinkSync(git, join(tools, "git"));
    const runtime = process.platform === "darwin" ? "hc" : "herdr";
    writeFileSync(join(tools, runtime), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Replacing process.env in the test runner does not replace Bun.which's default environment.
    const child = Bun.spawn(
      [process.execPath, "test", join(import.meta.dir, "fixtures/release-isolated-source-bundle.test.ts")],
      {
        cwd: f.root,
        env: { HOME: f.paths.home, PATH: tools, DORI_TEST_ISOLATED_SOURCE_BUNDLE: tools },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Isolated release fixture exited ${code}: ${stderr}\n${stdout}`);
    expect(stdout.split("\n")).toContain("ISOLATED_RELEASE_OK");
  },
  15_000,
);

posix(
  "isolated rollback retains the independent-native protocol without replacing its owned wrapper with a symlink",
  async () => {
    const f = fixture(true);
    const legacy = await installBundle(f.paths, f.release("independent").bundle, undefined);
    const config = readFileSync(f.paths.config);
    const bound = boundRelease(f, "bound");
    const current = await installBundle(f.paths, bound.bundle, legacy);
    expect(lstatSync(join(f.paths.dori, "bin/omp")).isSymbolicLink()).toBe(false);
    const rolled = await rollbackRelease(f.paths, current);
    expect(rolled.current).toEqual(legacy.current);
    expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, legacy.current));
    expect(lstatSync(join(f.paths.dori, "bin/omp")).isSymbolicLink()).toBe(false);
    expect(recoverInstalled(f.paths)).toEqual(rolled);
    expect(readFileSync(f.paths.config)).toEqual(config);
  },
);

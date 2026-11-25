import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix(
  "isolated source releases need no stock OMP and bind the native source to the loaded release",
  async () => {
    const f = fixture(true);
    const tools = join(f.root, "bound-tools");
    mkdirSync(tools, { mode: 0o700 });
    const git = Bun.which("git");
    if (!git) throw new Error("The Git fixture prerequisite is unavailable");
    symlinkSync(git, join(tools, "git"));
    // Replacing process.env in the test runner does not replace Bun.which's default environment.
    const child = Bun.spawn(
      [process.execPath, "test", join(import.meta.dir, "fixtures/release-isolated-source-bundle.test.ts")],
      {
        cwd: f.root,
        env: { HOME: f.paths.home, PATH: tools, CATALY_TEST_ISOLATED_SOURCE_BUNDLE: tools },
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

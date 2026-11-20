import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The authenticated ULW source verifier is provisioned with POSIX PATH syntax;
// the Windows workflow provisions only the native host fixtures.
const matrixTest = test.skipIf(process.platform === "win32");

matrixTest(
  "native prompt composition preserves roles, workflows and state",
  async () => {
    const root = resolve(import.meta.dir, "../..");
    const home = mkdtempSync(join(tmpdir(), "dori-native-matrix-"));
    try {
      const child = Bun.spawn(
        [process.execPath, join(root, "test/fixtures/omp-native-host/prompt-matrix.ts"), root, home],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: home,
            NO_COLOR: "1",
            PI_CODING_AGENT_DIR: join(home, "agent"),
            DORI_CONFIG: join(home, "config.json"),
            OMP_ULW_SCOPE_FILE: join(home, "scope.json"),
            DORI_TEST_OMP_ROOT: process.env.DORI_TEST_OMP_ROOT,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 25_000,
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toEqual({ nativeVersion: expect.stringMatching(/^18\./), cases: 30, networkAttempts: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);

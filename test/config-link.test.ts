import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32")("the harness selects the config the OS resolves after a symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "cataly-config-link-"));
  try {
    mkdirSync(join(home, "real/child"), { recursive: true });
    symlinkSync(join(home, "real/child"), join(home, "link"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessionRuntime: "unknown" }));
    writeFileSync(join(home, "real/config.json"), JSON.stringify({ sessionRuntime: "headless" }));
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "status"], {
      cwd: home,
      env: { HOME: home, CATALY_HOME: home, CATALY_CONFIG: "link/../config.json", CATALY_TELEMETRY: "0" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("RUNTIME headless (from config)");
  } finally {
    rmSync(home, { recursive: true });
  }
});

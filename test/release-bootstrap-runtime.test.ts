import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang runtime stubs.
const posix = test.skipIf(process.platform === "win32");

posix.each(["{}", '{"runtime":"hc"}'])(
  "legacy bootstrap holds unbound or conflicting preserved runtime %s before its old CLI can activate",
  (preserved) => {
    const f = fixture(linux);
    f.assets();
    const home = join(f.home, ".dori"),
      config = join(home, "config.json");
    mkdirSync(home);
    writeFileSync(config, preserved);
    const choice = () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
const {loadConfig} = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/dori-mode/scripts/src/config.ts"))});
const {runtimeChoice} = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/dori-mode/scripts/src/run.ts"))});
console.log(JSON.stringify(runtimeChoice(await loadConfig(), process.env)));`,
        ],
        {
          env: { HOME: f.home, DORI_HOME: home, DORI_CONFIG: config, PATH: join(f.root, "bin") },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(choice().kind).toBe("hc");
    const held = f.run(["--runtime", "herdr"]);
    expect(held.exitCode).not.toBe(0);
    expect(held.stderr.toString()).toContain(
      preserved === "{}"
        ? "Preserved config must explicitly select runtime"
        : "conflicts with preserved config runtime",
    );
    expect(readFileSync(config, "utf8")).toBe(preserved);
    expect(existsSync(f.result)).toBe(false);
    expect(existsSync(join(home, "legacy-installed"))).toBe(false);
    const selected = '{"runtime":"herdr","ownerValue":"preserved"}';
    writeFileSync(config, selected);
    const installed = f.run(["--runtime", "herdr"]);
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    expect(choice()).toEqual({ kind: "herdr", source: "config" });
    expect(readFileSync(config, "utf8")).toBe(selected);
  },
);

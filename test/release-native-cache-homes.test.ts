import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every directory.
const posix = test.skipIf(process.platform === "win32");

posix.each(["explicit", "environment", "loaded", "loaded-override"] as const)(
  "cache reports references across known homes with %s selection",
  async (selection) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-cache-homes-")));
    roots.push(root);
    const home = join(root, "home");
    const f = overlayFixture(join(root, "source"), join(root, "upstream"), "homes");
    const receipt = nativeCacheFixture(f.source, home, f.checkout);
    renameSync(f.source, join(root, "moved-source"));
    const primary = join(home, ".cataly");
    const defaultSide = join(home, ".omp-cataly");
    const environment = join(root, "environment-home");
    const configuredSide = join(root, "configured-side");
    const explicit = join(root, "explicit-home");
    const loaded = join(root, "loaded-home");
    const reference = join(root, "extra-reference");
    const scanned = [primary, defaultSide, environment, configuredSide, reference];
    const args = ["cache", "--reference", reference];
    if (selection === "explicit" || selection === "loaded-override") {
      args.push("--home", explicit);
      scanned.push(explicit);
    }
    let cli = resolve(import.meta.dir, "../src/release/cli.ts");
    if (selection.startsWith("loaded")) {
      scanned.push(loaded);
      // Exercise the loaded release's physical home, including an explicit --home overriding it.
      const release = join(loaded, "releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
      const built = await Bun.build({
        entrypoints: [cli],
        outdir: join(release, "src/release"),
        naming: "cli.js",
        target: "bun",
      });
      expect(built.success).toBe(true);
      cli = built.outputs[0]!.path;
    }
    for (const dir of scanned) {
      mkdirSync(join(dir, "bin"), { recursive: true });
      symlinkSync(receipt.omp, join(dir, "bin/omp"));
    }
    const result = Bun.spawnSync([process.execPath, cli, ...args], {
      env: {
        HOME: home,
        PATH: process.env["PATH"],
        CATALY_HOME: environment,
        OMP_CATALY_HOME: configuredSide,
      },
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.removes).toBe("nothing");
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].protectedBy).toEqual(
      expect.arrayContaining(scanned.map((dir) => `link ${join(dir, "bin/omp")}`)),
    );
    expect(existsSync(receipt.omp)).toBe(true);
  },
);

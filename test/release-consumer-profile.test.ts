import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix.each([
  ["linux/x64 primary", { platform: "linux", arch: "x64", runtime: "herdr", side: false }],
  ["linux/x64 side", { platform: "linux", arch: "x64", runtime: "herdr", side: true }],
  ["darwin/arm64 primary", { platform: "darwin", arch: "arm64", runtime: "hc", side: false }],
  ["darwin/arm64 side", { platform: "darwin", arch: "arm64", runtime: "hc", side: true }],
] as const)(
  "consumer %s holds missing runtime selection until the owner selects the launch runtime",
  (_, { platform, arch, runtime, side }) => {
    const f = fixture(true);
    const home = join(f.paths.home, side ? ".omp-dori" : ".dori");
    mkdirSync(home, { recursive: true });
    const config = join(home, "config.json");
    const preserved = JSON.stringify({ defaultModel: "owner/model", ownerValue: "unchanged" });
    writeFileSync(config, preserved);
    const bin = join(f.root, "runtimes");
    mkdirSync(bin);
    for (const kind of ["herdr", "hc"])
      writeFileSync(join(bin, kind), `#!/bin/sh\nprintf '${kind} witness\\n'\n`, { mode: 0o755 });
    const env = {
      HOME: f.paths.home,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      DORI_HOME: home,
      DORI_CONFIG: config,
    };
    const host = `Object.defineProperty(process, "platform", {value:${JSON.stringify(platform)}});
Object.defineProperty(process, "arch", {value:${JSON.stringify(arch)}});`;
    const cli = (argv: string[]) =>
      Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `${host}
const { runConsumerUpdate } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/cli.ts"))});
process.exit(await runConsumerUpdate(${JSON.stringify(argv)}));`,
        ],
        { env },
      );
    const choice = () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `${host}
const { loadConfig } = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/dori-mode/scripts/src/config.ts"))});
const { runtimeChoice } = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/dori-mode/scripts/src/run.ts"))});
console.log(JSON.stringify(runtimeChoice(await loadConfig(), process.env)));`,
        ],
        { env },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(choice()).toEqual({ kind: "hc", source: "detect:path" });
    const release = f.release("supported profile\n");
    for (const command of ["check", "install", "rollback"]) {
      for (const selection of [[], ["--runtime", runtime]]) {
        const argv = [command, "--home", home, ...selection];
        if (command !== "rollback") argv.push("--from", release.dist);
        const result = cli(argv);
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain("Preserved config must explicitly select runtime");
        expect(readFileSync(config, "utf8")).toBe(preserved);
        expect(existsSync(join(home, "src"))).toBe(false);
        expect(existsSync(join(home, "releases/consumer-installed.json"))).toBe(false);
      }
    }
    const selected = JSON.stringify({ ...JSON.parse(preserved), runtime });
    writeFileSync(config, selected);
    const checked = cli(["check", "--home", home, "--from", release.dist]);
    expect(checked.exitCode, checked.stderr.toString()).toBe(0);
    expect(choice()).toEqual({ kind: runtime, source: "config" });
    expect(readFileSync(config, "utf8")).toBe(selected);
  },
);

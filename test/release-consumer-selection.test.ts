import { expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { consumerPaths } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

test.each([".dori/nested", ".", ".dori/.."])("consumer side home %s cannot overlap primary ownership", (target) => {
  expect(() => consumerPaths("/sandbox/home", join("/sandbox/home", target))).toThrow("primary");
});

posix("consumer check rejects a legacy side target before creating its home", () => {
  const f = fixture();
  const legacy = f.release("legacy\n");
  const selected = join(f.paths.home, "legacy-side");
  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/release/cli.ts"),
      "check",
      "--home",
      selected,
      "--from",
      legacy.dist,
    ],
    { env: { HOME: f.paths.home, PATH: process.env["PATH"] } },
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Legacy releases do not support isolated homes");
  expect(existsSync(selected)).toBe(false);
});

posix.each(["check", "install", "rollback"])(
  "%s holds an explicit profile conflicting with preserved config",
  async (command) => {
    const f = fixture(true);
    if (command === "rollback") {
      const first = await installBundle(f.paths, f.release("first\n").bundle, undefined);
      await installBundle(f.paths, f.release("second\n").bundle, first);
    }
    const pointer = existsSync(f.paths.live) ? readlinkSync(f.paths.live) : undefined;
    const state = existsSync(f.paths.state) ? readFileSync(f.paths.state) : undefined;
    const runtime = process.platform === "darwin" ? "hc" : "herdr";
    const config = JSON.stringify({ runtime: runtime === "hc" ? "herdr" : "hc", defaultModel: "owner/model" });
    writeFileSync(f.paths.config, config);
    const args = [
      process.execPath,
      resolve(import.meta.dir, "../src/release/cli.ts"),
      command,
      "--home",
      f.paths.dori,
      "--runtime",
      runtime,
    ];
    if (command !== "rollback") args.push("--from", f.release("candidate\n").dist);
    const result = Bun.spawnSync(args, { env: { HOME: f.paths.home, PATH: process.env["PATH"] } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("conflicts with preserved config runtime");
    expect(readFileSync(f.paths.config, "utf8")).toBe(config);
    expect(existsSync(f.paths.live) ? readlinkSync(f.paths.live) : undefined).toBe(pointer);
    expect(existsSync(f.paths.state) ? readFileSync(f.paths.state) : undefined).toEqual(state);
  },
);

posix.each(["check", "install", "status", "rollback"])(
  "%s rejects an unsupported selected runtime before creating its home",
  (command) => {
    const f = fixture();
    const selected = join(f.paths.home, "unsupported-side");
    const result = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "../src/release/cli.ts"),
        command,
        "--home",
        selected,
        "--runtime",
        process.platform === "darwin" ? "herdr" : "hc",
      ],
      {
        env: { HOME: f.paths.home, PATH: process.env["PATH"] },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unsupported release host/runtime");
    expect(existsSync(selected)).toBe(false);
  },
);

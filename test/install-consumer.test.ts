import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumerPaths } from "../src/release/files.ts";
import { consumerEnv, installedConsumer, protectedSnapshot, snapshot } from "./install-consumer-setup.ts";
import { setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and asserts POSIX link and mode behaviour.
const posix = test.skipIf(process.platform === "win32");

posix("a consumer home with its extension link holds a non-terminal source install before any effects", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  source.upstreamCommit("pending upstream\n");
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  const r = source.install(consumerEnv(paths));
  expect(r.code).toBe(1);
  expect(protectedSnapshot(paths)).toEqual(before);
  expect(snapshot(source.src)).toBe(checkout);
  expect(existsSync(join(paths.home, ".omp-cataly"))).toBe(false);
  expect(existsSync(join(paths.home, "global-bin"))).toBe(false);
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

posix(
  "explicit primary source installation preserves the consumer pointer, config, pin, links and permissions",
  async () => {
    const source = setup();
    const { paths } = await installedConsumer();
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    for (const selectedSource of [source.src, ""]) {
      const r = source.install({ ...consumerEnv(paths), CATALY_INSTALL_MODE: "primary", CATALY_SRC: selectedSource });
      expect(r.code).toBe(1);
      expect(protectedSnapshot(paths)).toEqual(before);
      expect(snapshot(source.src)).toBe(checkout);
    }
    expect(existsSync(join(paths.cataly, "backups"))).toBe(false);
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

posix("a separate side source install and its reinstall preserve an installed consumer home", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  const before = protectedSnapshot(paths);
  const options = consumerEnv(paths);
  expect(source.install({ ...options, CATALY_INSTALL_MODE: "side" }).code).toBe(0);
  expect(protectedSnapshot(paths)).toEqual(before);
  const side = options.OMP_CATALY_HOME;
  const configPath = join(side, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  expect(config.stateDir).toBe(join(side, "state"));
  expect(config.agentCommand[0]).toBe(join(side, "bin/omp"));
  config.defaultModel = "fixture/preserved";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  expect(source.install(options).code).toBe(0);
  expect(protectedSnapshot(paths)).toEqual(before);
  expect(JSON.parse(readFileSync(configPath, "utf8")).defaultModel).toBe("fixture/preserved");
  expect(readlinkSync(join(options.OMP_CATALY_BIN_DIR, "omp-cataly"))).toBe(join(side, "bin/omp-cataly"));
});

posix(
  "side mode holds when its selected home is a consumer home or a symlink alias outside the primary home",
  async () => {
    const source = setup();
    const { paths } = await installedConsumer();
    const alias = join(source.home, "consumer-home");
    symlinkSync(paths.cataly, alias);
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    for (const base of [paths.cataly, alias]) {
      const r = source.install({ CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: base });
      expect(r.code).toBe(1);
      expect(protectedSnapshot(paths)).toEqual(before);
      expect(snapshot(source.src)).toBe(checkout);
    }
    expect(existsSync(join(source.home, "global-bin"))).toBe(false);
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

posix.each(["consumer-owner.json", "consumer-installed.json", "consumer-journal.json"])(
  "an incomplete selected consumer home with only %s holds side installation",
  (control) => {
    const source = setup();
    const paths = consumerPaths(join(source.root, "selected-consumer"));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(join(paths.root, control), "{interrupted\n");
    const alias = join(source.home, "consumer-home");
    symlinkSync(paths.cataly, alias);
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    expect(source.install({ CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: alias }).code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

posix(
  "side path overrides that resolve into the primary consumer home stop before checkout or package changes",
  async () => {
    const source = setup();
    const { paths } = await installedConsumer();
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    const overrides: Record<string, string>[] = [
      { OMP_CATALY_HOME: join(paths.cataly, "experiment") },
      { CATALY_SRC: paths.live },
      { OMP_CATALY_BIN_DIR: join(paths.cataly, "bin") },
    ];
    for (const override of overrides) {
      const r = source.install({ ...consumerEnv(paths), CATALY_INSTALL_MODE: "side", ...override });
      expect(r.code).toBe(1);
      expect(protectedSnapshot(paths)).toEqual(before);
      expect(snapshot(source.src)).toBe(checkout);
    }
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

posix("side config and wrapper symlinks cannot redirect generated files into the consumer home", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  const options = consumerEnv(paths);
  const side = options.OMP_CATALY_HOME;
  mkdirSync(join(side, "bin"), { recursive: true });
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  for (const entry of ["config.json", "bin/cataly"]) {
    const path = join(side, entry);
    symlinkSync(paths.config, path);
    const sideBefore = snapshot(side);
    expect(source.install({ ...options, CATALY_INSTALL_MODE: "side" }).code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
    expect(snapshot(side)).toBe(sideBefore);
    rmSync(path);
  }
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

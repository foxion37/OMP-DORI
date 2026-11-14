import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumerPaths } from "../src/release/files.ts";
import { consumerEnv, installedConsumer, protectedSnapshot, snapshot } from "./install-consumer-setup.ts";
import { setup } from "./install-setup.ts";

test("a consumer home with its extension link holds a non-terminal source install before any effects", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  source.upstreamCommit("pending upstream\n");
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  const r = source.install(consumerEnv(paths));
  expect(r.code).toBe(1);
  expect(protectedSnapshot(paths)).toEqual(before);
  expect(snapshot(source.src)).toBe(checkout);
  expect(existsSync(join(paths.home, ".omp-dori"))).toBe(false);
  expect(existsSync(join(paths.home, "global-bin"))).toBe(false);
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

test("explicit primary source installation preserves the consumer pointer, config, pin, links and permissions", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  for (const selectedSource of [source.src, ""]) {
    const r = source.install({ ...consumerEnv(paths), DORI_INSTALL_MODE: "primary", DORI_SRC: selectedSource });
    expect(r.code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
  }
  expect(existsSync(join(paths.dori, "backups"))).toBe(false);
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

test("a separate side source install and its reinstall preserve an installed consumer home", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  const before = protectedSnapshot(paths);
  const options = consumerEnv(paths);
  expect(source.install({ ...options, DORI_INSTALL_MODE: "side" }).code).toBe(0);
  expect(protectedSnapshot(paths)).toEqual(before);
  const side = options.OMP_DORI_HOME;
  const configPath = join(side, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  expect(config.stateDir).toBe(join(side, "state"));
  expect(config.agentCommand[0]).toBe(join(side, "bin/omp"));
  expect(config.ompUlwPath).toBe("");
  config.defaultModel = "fixture/preserved";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  expect(source.install(options).code).toBe(0);
  expect(protectedSnapshot(paths)).toEqual(before);
  expect(JSON.parse(readFileSync(configPath, "utf8")).defaultModel).toBe("fixture/preserved");
  expect(readlinkSync(join(options.OMP_DORI_BIN_DIR, "omp-dori"))).toBe(join(side, "bin/omp-dori"));
});

test("side mode holds when its selected home is a consumer home or a symlink alias outside the primary home", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  const alias = join(source.home, "consumer-home");
  symlinkSync(paths.dori, alias);
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  for (const base of [paths.dori, alias]) {
    const r = source.install({ DORI_INSTALL_MODE: "side", OMP_DORI_HOME: base });
    expect(r.code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
  }
  expect(existsSync(join(source.home, "global-bin"))).toBe(false);
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

test.each(["consumer-owner.json", "consumer-installed.json", "consumer-journal.json"])(
  "an incomplete selected consumer home with only %s holds side installation",
  (control) => {
    const source = setup();
    const paths = consumerPaths(join(source.root, "selected-consumer"));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(join(paths.root, control), "{interrupted\n");
    const alias = join(source.home, "consumer-home");
    symlinkSync(paths.dori, alias);
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    expect(source.install({ DORI_INSTALL_MODE: "side", OMP_DORI_HOME: alias }).code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

test("side path overrides that resolve into the primary consumer home stop before checkout or package changes", async () => {
  const source = setup();
  const { paths, ownedDependency } = await installedConsumer();
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  const overrides: Record<string, string>[] = [
    { OMP_DORI_HOME: join(paths.dori, "experiment") },
    { DORI_SRC: paths.live },
    { OMP_ULW_SRC: ownedDependency },
    { OMP_DORI_BIN_DIR: join(paths.dori, "bin") },
  ];
  for (const override of overrides) {
    const r = source.install({ ...consumerEnv(paths), DORI_INSTALL_MODE: "side", ...override });
    expect(r.code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
  }
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

test("side config and wrapper symlinks cannot redirect generated files into the consumer home", async () => {
  const source = setup();
  const { paths } = await installedConsumer();
  const options = consumerEnv(paths);
  const side = options.OMP_DORI_HOME;
  mkdirSync(join(side, "bin"), { recursive: true });
  const before = protectedSnapshot(paths);
  const checkout = snapshot(source.src);
  for (const entry of ["config.json", "bin/dori"]) {
    const path = join(side, entry);
    symlinkSync(paths.config, path);
    const sideBefore = snapshot(side);
    expect(source.install({ ...options, DORI_INSTALL_MODE: "side" }).code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
    expect(snapshot(side)).toBe(sideBefore);
    rmSync(path);
  }
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

test.each(["config", "retained"])(
  "a side %s ULW alias into the consumer home holds before source changes",
  async (choice) => {
    const source = setup();
    const { paths } = await installedConsumer();
    const options = consumerEnv(paths);
    const alias = join(source.root, "consumer-ulw");
    const protectedUlw = join(paths.dori, "source-ulw-fixture");
    mkdirSync(protectedUlw);
    writeFileSync(join(protectedUlw, "index.ts"), "export default () => {};\n");
    writeFileSync(join(protectedUlw, "presets.ts"), "export {};\n");
    symlinkSync(protectedUlw, alias);
    mkdirSync(options.OMP_DORI_HOME);
    const config = join(options.OMP_DORI_HOME, "config.json");
    const configBytes = JSON.stringify({ ompUlwPath: choice === "config" ? join(alias, "index.ts") : "" });
    writeFileSync(config, configBytes);
    if (choice === "retained") symlinkSync(alias, join(options.OMP_DORI_HOME, ".omp-dori-ulw"));
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    source.upstreamCommit("pending upstream\n");
    const r = source.install({ ...options, DORI_INSTALL_MODE: "side", OMP_ULW_SRC: "" });
    expect(r.code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
    expect(readFileSync(config, "utf8")).toBe(configBytes);
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

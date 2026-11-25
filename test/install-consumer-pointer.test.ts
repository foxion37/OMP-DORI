import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { consumerPaths } from "../src/release/files.ts";
import { consumerEnv, installedConsumer, protectedSnapshot, snapshot } from "./install-consumer-setup.ts";
import { setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and links homes with POSIX symlinks.
const posix = test.skipIf(process.platform === "win32");

posix(
  "a managed source pointer still protects primary and aliased side homes when control records are missing",
  async () => {
    const source = setup();
    const { paths } = await installedConsumer();
    for (const control of ["consumer-owner.json", "consumer-installed.json", "consumer-journal.json"]) {
      rmSync(join(paths.root, control), { force: true });
    }
    const alias = join(source.home, "consumer-home");
    symlinkSync(paths.cataly, alias);
    const before = protectedSnapshot(paths);
    const checkout = snapshot(source.src);
    expect(source.install(consumerEnv(paths)).code).toBe(1);
    expect(source.install({ CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: alias }).code).toBe(1);
    expect(protectedSnapshot(paths)).toEqual(before);
    expect(snapshot(source.src)).toBe(checkout);
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

posix(
  "a pointer-only consumer under a symlinked HOME parent holds primary and direct or aliased side installs",
  async () => {
    const source = setup();
    const { root, paths: physicalPaths } = await installedConsumer();
    const parent = join(source.root, "consumer-home-parent");
    symlinkSync(root, parent);
    const home = join(parent, "home");
    const paths = consumerPaths(home, join(home, basename(physicalPaths.cataly)));
    const target = join(paths.releases, basename(readlinkSync(paths.live)));
    rmSync(paths.live);
    symlinkSync(target, paths.live);
    for (const control of ["consumer-owner.json", "consumer-installed.json", "consumer-journal.json"]) {
      rmSync(join(paths.root, control), { force: true });
    }
    const alias = join(source.home, "consumer-home");
    symlinkSync(physicalPaths.cataly, alias);
    source.upstreamCommit("pending upstream\n");
    const before = snapshot(paths.home);
    const sourceHome = snapshot(source.home);
    const checkout = snapshot(source.src);
    const attempts: Record<string, string>[] = [
      { ...consumerEnv(paths), CATALY_INSTALL_MODE: "primary" },
      { CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: physicalPaths.cataly },
      { CATALY_INSTALL_MODE: "side", OMP_CATALY_HOME: alias },
    ];
    for (const options of attempts) {
      const r = source.install(options);
      expect(r.code).toBe(1);
      expect(snapshot(paths.home)).toBe(before);
      expect(snapshot(source.home)).toBe(sourceHome);
      expect(snapshot(source.src)).toBe(checkout);
    }
    expect(existsSync(join(source.root, "bun.log"))).toBe(false);
  },
);

posix("an intact consumer home is not mistaken for source, even with a source marker", () => {
  const source = setup();
  const base = join(source.home, ".cataly");
  const release = join(base, "releases/releases/active");
  mkdirSync(release, { recursive: true });
  symlinkSync("releases/releases/active", join(base, "src"));
  writeFileSync(join(base, ".omp-cataly"), "primary\n");
  writeFileSync(join(base, "config.json"), '{"owner":"consumer"}\n');
  const before = snapshot(source.home);

  const result = source.install({ CATALY_INSTALL_MODE: "primary" });
  expect(result.code).toBe(1);
  expect(result.err).toContain(`${base} is managed by the consumer release installer`);
  expect(snapshot(source.home)).toBe(before);
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

posix.each(["existing", "missing", "not-directory"])(
  "ordinary source pointers with %s parents remain compatible with primary source installation",
  (parent) => {
    const source = setup();
    const base = join(source.home, ".cataly");
    mkdirSync(base);
    let target = parent === "existing" ? source.src : join(source.root, parent, "checkout");
    if (parent === "not-directory") {
      writeFileSync(join(source.root, parent), "ordinary source parent\n");
      target = join(source.root, parent, "nested", "checkout");
    }
    symlinkSync(target, join(base, "src"));
    expect(source.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" }).code).toBe(0);
    expect(readlinkSync(join(base, "src"))).toBe(target);
    expect(readlinkSync(join(source.home, "global-bin/cataly"))).toBe(join(source.src, source.cli));
    expect(JSON.parse(readFileSync(join(base, "config.json"), "utf8")).agentCommand[0]).toBe(join(base, "bin/omp"));
  },
);

posix("a source pointer parent resolution error holds before checkout or installation effects", () => {
  const source = setup();
  const loop = join(source.root, "loop");
  symlinkSync(loop, loop);
  const base = join(source.home, ".cataly");
  mkdirSync(base);
  symlinkSync(join(loop, "checkout"), join(base, "src"));
  const before = snapshot(source.home);
  const checkout = snapshot(source.src);
  const r = source.install({ CATALY_INSTALL_MODE: "primary" });
  expect(r.code).toBe(1);
  expect(snapshot(source.home)).toBe(before);
  expect(snapshot(source.src)).toBe(checkout);
  expect(existsSync(join(source.root, "bun.log"))).toBe(false);
});

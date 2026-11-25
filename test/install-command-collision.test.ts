import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { script, setup } from "./install-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs linked through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

// Version/argv stubs only; setup records package installs without installing dependencies.
const executable = `#!/bin/sh
if [ -n "\${INSTALL_TEST_OMP_PROBE:-}" ]; then printf '%s\\n' "$*" >> "$INSTALL_TEST_OMP_PROBE"; fi
if [ "\${1:-}" = --version ]; then echo 'omp 19.0.1'; else printf '%s\\0' "$0" "$@"; fi
`;

for (const mode of ["primary", "side"]) {
  posix.each(["direct path", "relative path", "selection symlink", "destination symlink", "parent alias", "hard link"])(
    `${mode} holds an override through %s before version, checkout or install mutations`,
    (alias) => {
      const s = setup();
      const base = join(s.home, mode === "primary" ? ".cataly" : ".omp-cataly");
      const wrapper = join(base, "bin/omp");
      const tools = join(s.root, "tools");
      mkdirSync(join(base, "bin"), { recursive: true });
      mkdirSync(tools);
      let selected = alias === "destination symlink" ? join(tools, "native") : wrapper;
      writeFileSync(selected, executable, { mode: 0o755 });
      if (alias === "relative path") selected = `./${relative(s.root, wrapper)}`;
      if (alias === "selection symlink") {
        selected = join(tools, "selected");
        symlinkSync(wrapper, selected);
      }
      if (alias === "destination symlink") symlinkSync(selected, wrapper);
      if (alias === "parent alias") {
        symlinkSync(join(base, "bin"), join(tools, "native bin"));
        selected = join(tools, "native bin/omp");
      }
      if (alias === "hard link") {
        selected = join(tools, "native");
        linkSync(wrapper, selected);
      }
      const selectedPath = resolve(s.root, selected);
      const inode = statSync(selectedPath).ino;
      const wrapperIsLink = lstatSync(wrapper).isSymbolicLink();
      const config = '{"owner":"preserve on hold"}\n';
      writeFileSync(join(base, "config.json"), config);
      s.upstreamCommit("v2\n");
      const installed = Bun.spawnSync([script], {
        cwd: s.root,
        env: s.env({
          CATALY_INSTALL_MODE: mode,
          CATALY_OMP: selected,
          INSTALL_TEST_OMP_PROBE: join(s.root, "version.log"),
        }),
      });
      expect(installed.exitCode).toBe(1);
      expect(installed.stderr.toString()).toContain(`aliases generated wrapper ${wrapper}`);
      expect(readFileSync(selectedPath, "utf8")).toBe(executable);
      expect(readFileSync(wrapper, "utf8")).toBe(executable);
      expect(statSync(selectedPath).ino).toBe(inode);
      expect(lstatSync(wrapper).isSymbolicLink()).toBe(wrapperIsLink);
      expect(readFileSync(join(base, "config.json"), "utf8")).toBe(config);
      expect(readFileSync(join(s.src, s.cli), "utf8")).toBe("v1\n");
      for (const path of [
        join(s.root, "version.log"),
        join(s.root, "bun.log"),
        join(s.home, "skills"),
        join(s.home, "extensions"),
        join(s.home, "global-bin"),
        ...[".omp-cataly", "backups", "env.sh", "omp.yml"].map((name) => join(base, name)),
      ]) {
        expect(existsSync(path)).toBe(false);
      }
    },
  );

  posix(`${mode} infers its destination before holding a selected wrapper`, () => {
    const s = setup();
    const base = join(s.home, mode === "primary" ? ".cataly" : ".omp-cataly");
    const wrapper = join(base, "bin/omp");
    mkdirSync(join(base, "bin"), { recursive: true });
    writeFileSync(wrapper, executable, { mode: 0o755 });
    if (mode === "side") writeFileSync(join(base, ".omp-cataly"), "side\n");
    const result = s.install({ CATALY_OMP: wrapper });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`aliases generated wrapper ${wrapper}`);
    expect(readFileSync(wrapper, "utf8")).toBe(executable);
    expect(existsSync(join(base, "config.json"))).toBe(false);
    expect(existsSync(join(s.root, "bun.log"))).toBe(false);
    if (mode === "side") expect(readFileSync(join(base, ".omp-cataly"), "utf8")).toBe("side\n");
    else expect(existsSync(join(base, ".omp-cataly"))).toBe(false);
  });

  posix(`${mode} also holds the bound dependency producer when its launcher aliases a wrapper`, () => {
    const s = setup();
    // This fixture has synthetic addon bytes; it proves receipt/path admission, not native loading.
    const native = overlayFixture(s.src, join(s.root, "native-upstream"));
    const receipt = nativeCacheFixture(s.src, s.home, native.checkout);
    const bytes = readFileSync(receipt.omp);
    const base = join(s.home, mode === "primary" ? ".cataly" : ".omp-cataly");
    const wrapper = join(base, "bin/omp");
    mkdirSync(join(base, "bin"), { recursive: true });
    symlinkSync(receipt.omp, wrapper);
    const result = s.install({ CATALY_INSTALL_MODE: mode, CATALY_OMP: "", CATALY_NO_PULL: "1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`aliases generated wrapper ${wrapper}`);
    expect(readFileSync(receipt.omp)).toEqual(bytes);
    expect(readFileSync(wrapper)).toEqual(bytes);
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(true);
    expect(existsSync(join(base, "config.json"))).toBe(false);
    expect(existsSync(join(s.root, "bun.log"))).toBe(false);
  });
}

posix.each(["cataly", "omp-cataly"])("side holds an override before replacing its %s wrapper", (name) => {
  const s = setup();
  const base = join(s.home, ".omp-cataly");
  const selected = join(base, "bin", name);
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(selected, executable, { mode: 0o755 });
  writeFileSync(join(base, "bin/omp"), "previous omp wrapper\n");
  const result = s.install({ CATALY_INSTALL_MODE: "side", CATALY_OMP: selected });
  expect(result.code).toBe(1);
  expect(result.err).toContain(`aliases generated wrapper ${selected}`);
  expect(readFileSync(selected, "utf8")).toBe(executable);
  expect(readFileSync(join(base, "bin/omp"), "utf8")).toBe("previous omp wrapper\n");
  expect(existsSync(join(base, "config.json"))).toBe(false);
  expect(existsSync(join(s.root, "bun.log"))).toBe(false);
});

posix.each(["cataly", "omp-cataly"])("primary preserves the independent %s executable it does not wrap", (name) => {
  const s = setup();
  const base = join(s.home, ".cataly");
  const selected = join(base, "bin", name);
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(selected, executable, { mode: 0o755 });
  const env = s.env({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1", CATALY_OMP: selected });
  const installed = Bun.spawnSync([script], { cwd: s.root, env });
  expect(installed.exitCode).toBe(0);
  expect(readFileSync(selected, "utf8")).toBe(executable);
  const child = Bun.spawnSync([join(base, "bin/omp"), "independent control"], { cwd: s.root, env });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().split("\0").slice(0, -1)).toEqual([selected, "independent control"]);
  expect(readFileSync(selected, "utf8")).toBe(executable);
});

posix("primary holds its existing generated wrapper instead of trusting its embedded executable", () => {
  const s = setup();
  const options = { CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" };
  expect(s.install(options).code).toBe(0);
  const wrapper = join(s.home, ".cataly/bin/omp");
  const bytes = readFileSync(wrapper);
  const native = join(s.root, "bin/omp");
  const nativeBytes = readFileSync(native);
  const installs = readFileSync(join(s.root, "bun.log"));
  const result = s.install({ ...options, CATALY_OMP: wrapper });
  expect(result.code).toBe(1);
  expect(result.err).toContain(`aliases generated wrapper ${wrapper}`);
  expect(readFileSync(wrapper)).toEqual(bytes);
  expect(readFileSync(native)).toEqual(nativeBytes);
  expect(readFileSync(join(s.root, "bun.log"))).toEqual(installs);
});

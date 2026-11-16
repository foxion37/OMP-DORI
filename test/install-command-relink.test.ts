import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { script, setup } from "./install-setup.ts";

// Version/argv fixtures; the real installer runs while dependency installation is recorded by setup.
const executable = '#!/bin/sh\nif [ "$1" = --version ]; then echo 18.20.0; else printf \'%s\\0\' "$0" "$@"; fi\n';

for (const mode of ["primary", "side"]) {
  test.each(["direct", "leaf chain", "parent alias", "directory prefix"])(
    `${mode} holds a native selection traversing the command relink through %s`,
    (alias) => {
      const s = setup();
      const base = join(s.home, mode === "primary" ? ".dori" : ".omp-dori");
      const bin = join(s.home, "global-bin");
      const command = join(bin, mode === "primary" ? "dori" : "omp-dori");
      const tools = join(s.root, "tools");
      mkdirSync(tools);
      mkdirSync(bin);
      mkdirSync(base);
      const native = join(tools, "omp");
      writeFileSync(native, executable, { mode: 0o755 });
      symlinkSync(alias === "directory prefix" ? tools : native, command);
      let selected = alias === "directory prefix" ? join(command, "omp") : command;
      if (alias === "leaf chain") {
        symlinkSync(relative(tools, command), join(tools, "inner"));
        symlinkSync("inner", join(tools, "outer"));
        selected = join(tools, "outer");
      }
      if (alias === "parent alias") {
        symlinkSync(bin, join(tools, "command-bin"));
        selected = join(tools, "command-bin", mode === "primary" ? "dori" : "omp-dori");
      }
      const originalLink = readlinkSync(command);
      const config = '{"owner":"preserve"}\n';
      writeFileSync(join(base, "config.json"), config);
      s.upstreamCommit("v2\n");
      const result = s.install({ DORI_INSTALL_MODE: mode, DORI_OMP: selected });
      expect(result.code).toBe(1);
      expect(result.err).toContain(`traverses installation command link ${command}`);
      expect(readlinkSync(command)).toBe(originalLink);
      expect(readFileSync(selected, "utf8")).toBe(executable);
      expect(readFileSync(native, "utf8")).toBe(executable);
      expect(readFileSync(join(base, "config.json"), "utf8")).toBe(config);
      expect(readFileSync(join(s.src, s.cli), "utf8")).toBe("v1\n");
      for (const path of [
        join(s.root, "bun.log"),
        join(base, "backups"),
        join(base, ".omp-dori"),
        join(base, "env.sh"),
      ])
        expect(existsSync(path)).toBe(false);
    },
  );

  test.each(["physical target", "independent symlink", "hard link"])(
    `${mode} permits the independent %s of a command link being replaced`,
    (alias) => {
      const s = setup();
      const base = join(s.home, mode === "primary" ? ".dori" : ".omp-dori");
      const bin = join(s.home, "global-bin");
      const command = join(bin, mode === "primary" ? "dori" : "omp-dori");
      const tools = join(s.root, "tools");
      mkdirSync(tools);
      mkdirSync(bin);
      const native = join(tools, "omp");
      writeFileSync(native, executable, { mode: 0o755 });
      symlinkSync(native, command);
      let selected = native;
      if (alias !== "physical target") {
        selected = join(tools, "independent");
        if (alias === "independent symlink") symlinkSync(native, selected);
        else linkSync(native, selected);
      }
      const inode = statSync(selected).ino;
      const env = s.env({ DORI_INSTALL_MODE: mode, DORI_NO_PULL: "1", DORI_OMP: selected });
      const installed = Bun.spawnSync([script], { cwd: s.root, env });
      expect(installed.exitCode).toBe(0);
      expect(readlinkSync(command)).not.toBe(native);
      expect(readFileSync(selected, "utf8")).toBe(executable);
      expect(statSync(selected).ino).toBe(inode);
      const child = Bun.spawnSync([join(base, "bin/omp"), "independent control"], { cwd: s.root, env });
      expect(child.exitCode).toBe(0);
      const argv = child.stdout.toString().split("\0").slice(0, -1);
      expect(argv[0]).toBe(selected);
      expect(argv.at(-1)).toBe("independent control");
    },
  );

  test(`${mode} retains an existing regular command that link installation leaves untouched`, () => {
    const s = setup();
    const bin = join(s.home, "global-bin");
    const command = join(bin, mode === "primary" ? "dori" : "omp-dori");
    mkdirSync(bin);
    writeFileSync(command, executable, { mode: 0o755 });
    const result = s.install({ DORI_INSTALL_MODE: mode, DORI_NO_PULL: "1", DORI_OMP: command });
    expect(result.code).toBe(mode === "primary" ? 1 : 0);
    expect(result.err).toContain("exists and is not a link; leaving it alone");
    expect(result.err).not.toContain("traverses installation command link");
    expect(readFileSync(command, "utf8")).toBe(executable);
  });
}

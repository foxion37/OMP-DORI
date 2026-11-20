import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { script, withUlwRemote } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs linked through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

// Actual installer and bound ULW admission; package installs and native argv are labeled fixtures.
posix.each(["tools", "./tools", ".", "tools with 'quote'; literal", "absolute"])(
  "the primary guard preserves Bun selected through PATH entry %s",
  (entry) => {
    const s = withUlwRemote();
    const tools = entry === "absolute" ? join(s.root, "absolute tools") : join(s.root, entry);
    mkdirSync(tools, { recursive: true });
    symlinkSync(join(s.root, "bin/bun"), join(tools, "bun"));
    const native = join(s.root, "selected-omp");
    writeFileSync(
      native,
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 18.20.0; else printf \'%s\\0\' "$0" "$@"; fi\n',
      { mode: 0o755 },
    );
    const env = s.env({
      DORI_INSTALL_MODE: "primary",
      DORI_OMP: native,
      OMP_ULW_SRC: "",
      OMP_ULW_REPO: s.remote,
      PATH: `${entry === "absolute" ? tools : entry}:${join(s.root, "bin")}:${process.env["PATH"]}`,
    });
    const installed = Bun.spawnSync([script], { cwd: s.root, env });
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    const wrapper = join(s.home, ".dori/bin/omp");
    const config = readFileSync(join(s.home, ".dori/config.json"));
    const ordinary = join(s.root, "ordinary");
    mkdirSync(ordinary);
    const prompt = "literal ; $(touch relative-bun-suffix)";
    for (const cwd of [s.root, ordinary]) {
      const launched = Bun.spawnSync([wrapper, "probe", prompt], { cwd, env });
      expect(launched.exitCode).toBe(0);
      expect(launched.stderr.toString()).toBe("");
      expect(launched.stdout.toString().split("\0").slice(0, -1)).toEqual([native, "probe", prompt]);
      expect(existsSync(join(cwd, "relative-bun-suffix"))).toBe(false);
    }
    expect(readFileSync(join(s.home, ".dori/config.json"))).toEqual(config);
    writeFileSync(join(s.home, ".dori/omp-ulw/index.ts"), "export default () => {}; // changed\n");
    const held = Bun.spawnSync([wrapper, "probe"], { cwd: ordinary, env });
    expect(held.exitCode).not.toBe(0);
    expect(held.stdout.toString()).toBe("");
    expect(held.stderr.toString()).toContain(
      "Bound source checkout differs from its upstream, patch or resulting tree",
    );
  },
);

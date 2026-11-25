import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { script, setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs linked through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

// Actual installer; package installs and native argv are labeled fixtures.
posix.each(["tools", "./tools", ".", "tools with 'quote'; literal", "absolute"])(
  "the primary guard preserves Bun selected through PATH entry %s",
  (entry) => {
    const s = setup();
    const tools = entry === "absolute" ? join(s.root, "absolute tools") : join(s.root, entry);
    mkdirSync(tools, { recursive: true });
    symlinkSync(join(s.root, "bin/bun"), join(tools, "bun"));
    const native = join(s.root, "selected-omp");
    writeFileSync(
      native,
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 19.0.1; else printf \'%s\\0\' "$0" "$@"; fi\n',
      { mode: 0o755 },
    );
    const env = s.env({
      CATALY_INSTALL_MODE: "primary",
      CATALY_OMP: native,
      PATH: `${entry === "absolute" ? tools : entry}:${join(s.root, "bin")}:${process.env["PATH"]}`,
    });
    const installed = Bun.spawnSync([script], { cwd: s.root, env });
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    const wrapper = join(s.home, ".cataly/bin/omp");
    const config = readFileSync(join(s.home, ".cataly/config.json"));
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
    expect(readFileSync(join(s.home, ".cataly/config.json"))).toEqual(config);
  },
);

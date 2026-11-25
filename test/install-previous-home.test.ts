import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { foreignLeftovers, leftovers, OLD_CONFIG, oldPrimary, tree } from "./install-previous-setup.ts";
import { setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh, its bridge and POSIX links.
const posix = test.skipIf(process.platform === "win32");
const absent = (path: string) => lstatSync(path, { throwIfNoEntry: false }) === undefined;
const read = (path: string) => readFileSync(path, "utf8");

posix("an earlier omp-dori home is imported, validated and deleted, with its links and caches", async () => {
  const s = setup();
  const root = tree(s.home);
  const old = oldPrimary(s.home);
  leftovers(s.home, root);
  const r = s.install();
  expect(r.code, r.err).toBe(0);
  const target = join(s.home, ".cataly");
  const config = JSON.parse(read(join(target, "config.json")));
  expect(config.defaultModel).toBe("old/model");
  expect(config.hooks.up).toBe("exec ~/.cataly/bin/cataly up");
  expect(config.sessionsDir).toBe("~/.cataly/sessions");
  for (const key of ["runtime", "leadPane", "ompUlwPath", "launchKeywords", "stateDir"])
    expect(config).not.toHaveProperty(key);
  expect(await loadConfig(join(target, "config.json"), s.home, { HOME: s.home })).toBeDefined();
  expect(read(join(target, "discord-token"))).toBe("old-discord\n");
  expect(read(join(target, "owner.md"))).toBe("# Owner\n");
  expect(read(join(target, "owner-history/2026-01-01.md"))).toBe("# Snapshot\n");
  expect(r.err).toContain(`Imported settings from ${old} into ${target}`);
  expect(r.err).toContain(`Removed the previous installation ${old}`);
  expect(absent(old)).toBe(true);
  for (const path of [
    join(s.home, "extensions/omp-dori"),
    join(s.home, "extensions/omp-ulw"),
    join(s.home, "skills/dori-mode"),
    join(s.home, "global-bin/dori"),
    join(s.home, "global-bin/dori-harness"),
    join(s.home, "global-bin/omp-dori"),
    join(s.home, ".bun/install/global/node_modules/dori-mode-scripts"),
    join(s.home, ".bun/install/global/node_modules/dori-superagent"),
    join(s.home, ".cache/omp-dori"),
    join(s.home, ".cache/omp-cataly", `omp-ulw-${"a".repeat(64)}`),
  ])
    expect([path, absent(path)]).toEqual([path, true]);
});

posix("foreign same-named links, commands and homes are kept", () => {
  const s = setup();
  foreignLeftovers(s.home);
  const r = s.install();
  expect(r.code, r.err).toBe(0);
  for (const path of [
    join(s.home, "extensions/omp-dori"),
    join(s.home, "skills/dori-mode"),
    join(s.home, "global-bin/dori"),
    join(s.home, "global-bin/omp-dori"),
    join(s.home, ".dori/config.json"),
    join(s.home, ".dori/notes"),
  ])
    expect([path, existsSync(path)]).toEqual([path, true]);
  expect(r.err).not.toContain("Removed the previous installation");
});

posix("the target's own settings are never overwritten", () => {
  const s = setup();
  // A ~/.cataly an earlier version installed from source: its marker, and settings the owner changed.
  const target = join(s.home, ".cataly");
  mkdirSync(join(target, "bin"), { recursive: true });
  writeFileSync(join(target, ".omp-cataly"), "primary\n", { mode: 0o600 });
  writeFileSync(join(target, "config.json"), '{"defaultModel":"keep/this","runtime":"herdr"}\n', { mode: 0o600 });
  writeFileSync(join(target, "discord-token"), "keep-mine\n", { mode: 0o600 });
  oldPrimary(s.home);
  const r = s.install();
  expect(r.code, r.err).toBe(0);
  const config = JSON.parse(read(join(target, "config.json")));
  expect(config.defaultModel).toBe("keep/this");
  expect(read(join(target, "discord-token"))).toBe("keep-mine\n");
  expect(r.err).toContain(`Kept your defaultModel setting in ${join(target, "config.json")}`);
  expect(r.err).toContain(`Kept your discord-token in ${target}`);
  expect(absent(join(s.home, ".dori"))).toBe(true);
});

posix("a live process of the earlier home blocks only its deletion", async () => {
  const s = setup();
  oldPrimary(s.home);
  leftovers(s.home, tree(s.home));
  // A real process stands in for the earlier harness: its command line is what the bridge reads.
  const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", "--dori-role", "lane"], {
    env: { ...process.env, HOME: s.home },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const r = s.install();
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(s.home, ".dori"))).toBe(true);
    expect(r.err).toContain(`Kept ${join(s.home, ".dori")}: process ${sleeper.pid} `);
    expect(r.err).toContain("the next install retries");
    expect(absent(join(s.home, "extensions/omp-dori"))).toBe(true);
    expect(absent(join(s.home, "global-bin/dori"))).toBe(true);
    expect(read(join(s.home, ".cataly/config.json"))).toContain("old/model");
  } finally {
    sleeper.kill();
    await sleeper.exited;
  }
  const retried = s.install();
  expect(retried.code, retried.err).toBe(0);
  expect(absent(join(s.home, ".dori"))).toBe(true);
});

posix("a second install finds nothing to remove", () => {
  const s = setup();
  oldPrimary(s.home);
  leftovers(s.home, tree(s.home));
  expect(s.install().code).toBe(0);
  const again = s.install();
  expect(again.code, again.err).toBe(0);
  expect(again.err).not.toContain("Removed");
  expect(again.err).not.toContain("Kept");
  expect(OLD_CONFIG.defaultModel).toBe("old/model");
});

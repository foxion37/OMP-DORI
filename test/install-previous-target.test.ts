import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh, its bridge and POSIX links.
const posix = test.skipIf(process.platform === "win32");
const read = (path: string) => readFileSync(path, "utf8");

/** A ~/.cataly an earlier version installed from source: the omp-ulw overlay, omp-dori commands and a herdr config. */
function earlierHome(home: string) {
  const target = join(home, ".cataly");
  const cache = join(home, ".cache/omp-cataly", `omp-ulw-${"b".repeat(64)}`);
  for (const dir of [target, join(target, "bin"), join(target, "skills/omp-dori-mode")])
    mkdirSync(dir, { recursive: true });
  for (const dir of [join(target, "releases/releases"), cache]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(target, ".omp-cataly"), "primary\n", { mode: 0o600 });
  writeFileSync(
    join(target, "config.json"),
    `${JSON.stringify({
      defaultModel: "mine/model",
      runtime: "hc",
      sessionRuntime: "hc",
      leadPane: "hc:2",
      ompUlwPath: join(target, "omp-ulw/index.ts"),
      launchKeywords: "ulw set goal and work",
      hooks: { down: `exec ${join(target, "bin/dori")} down` },
    })}\n`,
    { mode: 0o600 },
  );
  symlinkSync(cache, join(target, "omp-ulw"));
  symlinkSync(cache, join(target, ".omp-cataly-ulw"));
  writeFileSync(join(target, "bin/dori"), `#!/usr/bin/env bash\nset -euo pipefail\nexec ${target}/bin/cataly "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(target, "skills/omp-dori-mode/SKILL.md"),
    "---\nname: omp-dori-mode\ndescription: x\n---\n\n# x\n",
  );
  return { target, cache };
}

posix("an older ~/.cataly is converted in place: its config, omp-ulw entries and omp-dori commands", async () => {
  const s = setup();
  const { target, cache } = earlierHome(s.home);
  const r = s.install();
  expect(r.code, r.err).toBe(0);
  const config = JSON.parse(read(join(target, "config.json")));
  expect(config.defaultModel).toBe("mine/model");
  expect(config.hooks.down).toBe(`exec ${join(target, "bin/cataly")} down`);
  for (const key of ["runtime", "sessionRuntime", "leadPane", "ompUlwPath", "launchKeywords"])
    expect(config).not.toHaveProperty(key);
  expect(await loadConfig(join(target, "config.json"), s.home, { HOME: s.home })).toBeDefined();
  expect(r.err).toContain(`Converted ${join(target, "config.json")} to the current format`);
  expect(r.err).toContain(`Removed the omp-ulw overlay link ${join(target, "omp-ulw")}`);
  for (const path of [
    join(target, ".omp-cataly-ulw"),
    join(target, "bin/dori"),
    join(target, "skills/omp-dori-mode"),
    join(target, ".omp-dori"),
    cache,
  ])
    expect([path, existsSync(path)]).toEqual([path, false]);
  const again = s.install();
  expect(again.code, again.err).toBe(0);
  expect(again.err).not.toContain("Converted");
  expect(again.err).not.toContain("Removed ");
});

/** The bridge the release installer runs, with the same arguments it passes. */
function bridge(home: string, phase: "import" | "retire", target: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../scripts/previous-install/cli.ts"),
      phase,
      "--home",
      target,
      "--mode",
      "primary",
      ...(phase === "retire" ? ["--source", join(target, "src")] : []),
    ],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
  );
}

posix("a release store in the omp-dori format is replaced, keeping the owner's automatic-update choice", () => {
  const s = setup();
  const { target } = earlierHome(s.home);
  const root = join(target, "releases");
  const release = join(root, "releases", `${"c".repeat(40)}-${"d".repeat(16)}`);
  mkdirSync(join(release, "scripts/consumer"), { recursive: true });
  writeFileSync(join(release, "scripts/consumer/omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(root, "consumer-installed.json"),
    `${JSON.stringify({ version: 1, current: { version: 1, product: "omp-dori", releaseVersion: "0.1.3" } })}\n`,
  );
  writeFileSync(join(root, "consumer-automatic.json"), `${JSON.stringify({ version: 1, enabled: false })}\n`);
  symlinkSync(join(release, "scripts/consumer/omp"), join(target, "bin/omp"));
  symlinkSync(release, join(target, "src"));
  // A consumer home of the old format is the release installer's to convert; install-source.sh holds on it.
  expect(s.install().code).toBe(1);
  const r = bridge(s.home, "import", target);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(existsSync(join(root, "consumer-installed.json"))).toBe(false);
  expect(existsSync(release)).toBe(false);
  expect(existsSync(join(target, "src"))).toBe(false);
  expect(existsSync(join(target, "bin/omp"))).toBe(false);
  expect(JSON.parse(read(join(root, "consumer-automatic.json")))).toEqual({ version: 1, enabled: false });
});

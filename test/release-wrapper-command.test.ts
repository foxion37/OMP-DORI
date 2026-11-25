import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";
import { readArchive } from "../src/release/archive.ts";
import { consumerPaths, initialize } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { releasePath } from "../src/release/state.ts";
import { sourceManifest } from "../src/update/source.ts";
import { archive, fixture, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix("isolated wrappers quote the loaded release and clear foreign selection in a shell-sensitive home", async () => {
  const f = fixture(true);
  const paths = consumerPaths(
    f.paths.home,
    join(f.paths.home, "Library/Application Support/omp-cataly 'quote';$(touch injected)"),
  );
  initialize(paths);
  const bound = boundRelease({ ...f, paths }, "wrapper");
  // Carry the shipped harness and resolver unchanged so their default source root is the physical release.
  for (const path of ["src", "skills/cataly-mode/scripts/src", "package.json", "release-headless.json"])
    cpSync(resolve(import.meta.dir, "..", path), join(bound.source, path), { recursive: true });
  const probe = `import { agentCommand, defaultDeps } from "./harness.ts";
import { bindCliEnvironment } from "./cli-environment.ts";
bindCliEnvironment();
const deps = defaultDeps();
const roles = Object.fromEntries(["cataly", "lane"].map(role => {
  const command = agentCommand(deps, role);
  const parsed = Bun.spawnSync(["/bin/sh", "-c", "set -- " + command + "; printf '%s\\\\0' \\"$@\\""]);
  return [role, { code: parsed.exitCode, argv: parsed.stdout.toString().split("\\0").slice(0, -1) }];
}));
console.log(JSON.stringify({
  home: process.env.CATALY_HOME, config: process.env.CATALY_CONFIG,
  agent: process.env.CATALY_AGENT_CMD ?? null, argv: process.env.CATALY_AGENT_ARGV ?? null,
  state: process.env.CATALY_STATE_DIR ?? null, runtime: process.env.CATALY_RUNTIME ?? null,
  startup: process.env.CATALY_MANAGED_STARTUP ?? null,
  command: deps.agentCmd, roles,
}));
`;
  writeFileSync(join(bound.source, "src/cli.ts"), probe);
  const source = sourceManifest(bound.source);
  const bytes = archive(
    source.files.map((file) => ({
      name: `${bound.bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(bound.source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(validateReleaseManifest({ ...bound.bundle.manifest, source }), bytes);
  const installed = await installBundle(paths, { manifest, files: readArchive(bytes, manifest) }, undefined);
  const release = releasePath(paths, installed.current);
  const cwd = join(f.root, "workspace");
  mkdirSync(cwd);
  const result = Bun.spawnSync(["/bin/bash", join(paths.cataly, "bin/cataly-harness")], {
    cwd,
    env: {
      HOME: paths.home,
      PATH: process.env["PATH"],
      CATALY_HOME: f.paths.cataly,
      CATALY_CONFIG: f.paths.config,
      CATALY_AGENT_CMD: "touch inherited-command-ran",
      CATALY_AGENT_ARGV: '["/foreign/omp"]',
      CATALY_STATE_DIR: "foreign-state",
      CATALY_RUNTIME: "headless",
      CATALY_MANAGED_STARTUP: "1",
      CATALY_TELEMETRY: "0",
    },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const observed = JSON.parse(result.stdout.toString());
  const expected = [
    join(release, "scripts/consumer/omp"),
    "--no-extensions",
    "-e",
    join(release, "extension"),
    "--config",
    join(paths.cataly, "omp.yml"),
    "--config",
    join(paths.root, "consumer-discovery", basename(release), "omp.yml"),
  ];
  expect(observed).toMatchObject({
    home: paths.cataly,
    config: paths.config,
    agent: join(paths.cataly, "bin/omp"),
    argv: null,
    state: null,
    runtime: "headless",
    startup: null,
    command: expected.map(shq).join(" "),
  });
  for (const role of ["cataly", "lane"]) {
    expect(observed.roles[role]).toEqual({ code: 0, argv: [...expected, "--cataly-role", role] });
  }
  expect(existsSync(join(cwd, "injected"))).toBe(false);
  expect(existsSync(join(cwd, "inherited-command-ran"))).toBe(false);
});

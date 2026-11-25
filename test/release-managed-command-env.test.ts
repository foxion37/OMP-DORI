import { expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";
import { readArchive } from "../src/release/archive.ts";
import { installBundle } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { releasePath } from "../src/release/state.ts";
import { sourceManifest } from "../src/update/source.ts";
import { archive, fixture, withArchive } from "./release-consumer-setup.ts";
import { boundRelease } from "./release-native-recovery-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

posix.each(["normalization", "recovery"] as const)(
  "physical consumer readback and commands preserve owner choices (%s)",
  async (scenario) => {
    const f = fixture(true);
    const bound = boundRelease(f, "managed-command-env");
    for (const path of ["src", "skills/cataly-mode/scripts/src", "package.json"])
      cpSync(resolve(import.meta.dir, "..", path), join(bound.source, path), { recursive: true });
    const source = sourceManifest(bound.source);
    const bytes = archive(
      source.files.map((file) => ({
        name: `${bound.bundle.manifest.archive.root}/${file.path}`,
        bytes: readFileSync(join(bound.source, file.path)),
        mode: file.executable ? 0o755 : 0o644,
      })),
    );
    const manifest = withArchive(validateReleaseManifest({ ...bound.bundle.manifest, source }), bytes);
    const previous = await installBundle(f.paths, f.release("readback-previous").bundle, undefined);
    const installed = await installBundle(f.paths, { manifest, files: readArchive(bytes, manifest) }, previous);
    const next = f.release("readback-next");
    const release = releasePath(f.paths, installed.current);
    // Native home lookup must see the real child startup environment, not an in-process HOME replacement.
    const managed = join(f.paths.cataly, "bin/omp");
    const expected = [
      join(release, "scripts/consumer/omp"),
      "--no-extensions",
      "-e",
      join(release, "extension"),
      "--config",
      join(f.paths.cataly, "omp.yml"),
      "--config",
      join(f.paths.root, "consumer-discovery", basename(release), "omp.yml"),
    ];
    const suffix = ["--cataly-role", "lane", "--model", "{model}", "--", "{prompt}"];
    writeFileSync(f.paths.config, JSON.stringify({ agentCommand: ["omp", ...suffix] }));
    const selected = [...expected, "--owner-option", ""];
    const payload = {
      release,
      previousTag: previous.current.tag,
      nextTag: next.bundle.manifest.tag,
      nextDist: next.dist,
      config: f.paths.config,
      home: f.paths.home,
      managed,
      expected,
      suffix,
      selected,
      expectedCommand: expected.map(shq).join(" "),
      selectedCommand: selected.map(shq).join(" "),
      custom: join(f.root, "owner executable 'quote'", "bin/omp"),
    };
    const probe = `
const assert = (await import("node:assert/strict")).default;
const { writeFileSync } = await import("node:fs");
const { dirname, join } = await import("node:path");
const { homedir } = await import("node:os");
const { loadConfig } = await import(process.argv[1]);
const { agentCommand, defaultDeps } = await import(process.argv[2]);
const { release, previousTag, nextTag, nextDist, config, home, managed, expected, suffix, selected, expectedCommand, selectedCommand, custom } = JSON.parse(process.argv[3]);
const { setupReadback } = await import(join(release, "src/setup-readback.ts"));
const { captureSetupFile } = await import(join(release, "src/setup-files.ts"));
const readback = () => setupReadback(captureSetupFile(config), "consumer-updater-reader", { path: config, home });
const mode = process.argv[4];
if (mode === "recovery") {
  delete process.env.CATALY_AGENT_CMD;
  writeFileSync(config, JSON.stringify({ agentCommand: ["omp", ...suffix] }));
  const { consumerPaths } = await import(join(release, "src/release/files.ts"));
  const { loadInstalled } = await import(join(release, "src/release/state.ts"));
  const { acquireBundle } = await import(join(release, "src/release/bundle.ts"));
  const { installBundle, rollbackRelease } = await import(join(release, "src/release/install.ts"));
  const paths = consumerPaths(home, dirname(config));
  const rolled = await rollbackRelease(paths, loadInstalled(paths));
  assert.equal(rolled.current.tag, previousTag);
  const updated = await installBundle(paths, await acquireBundle({ from: nextDist }), rolled);
  assert.equal(updated.current.tag, nextTag);
  const receipt = await readback();
  assert.equal(receipt.effective, "selected");
  assert.deepEqual(receipt.overridden, []);
} else if (mode === "foreign-home") {
  assert.notEqual(homedir(), home);
  assert.deepEqual((await loadConfig(config, home)).agentCommand, [...expected, ...suffix]);
} else {
  assert.equal(mode, "managed-commands");
  assert.equal(homedir(), home);
  assert.deepEqual((await loadConfig(config, home)).agentCommand, [...expected, ...suffix]);
  assert.equal(defaultDeps().agentCmd, expectedCommand);
  const normalized = await readback();
  assert.equal(normalized.effective, "selected");
  assert.deepEqual(normalized.overridden, []);
  for (const role of ["cataly", "lane"])
    assert.equal(agentCommand(defaultDeps(), role), expectedCommand + " --cataly-role " + role);
  delete process.env.CATALY_AGENT_CMD;
  writeFileSync(config, JSON.stringify({ agentCommand: [managed, ...suffix] }));
  assert.deepEqual((await loadConfig(config, home)).agentCommand, [...expected, ...suffix]);
  process.env.CATALY_AGENT_ARGV = JSON.stringify(selected);
  process.env.CATALY_AGENT_CMD = "touch ignored-shell-command";
  for (const first of ["omp", managed]) {
    writeFileSync(config, JSON.stringify({ agentCommand: [first, ...suffix] }));
    assert.deepEqual((await loadConfig(config, home)).agentCommand, [...selected, ...suffix]);
    const overridden = await readback();
    assert.equal(overridden.effective, "shadowed");
    assert.deepEqual(overridden.overridden, ["agentCommand"]);
  }
  assert.equal(defaultDeps().agentCmd, selectedCommand);
  writeFileSync(config, JSON.stringify({ agentCommand: [custom, ...suffix] }));
  assert.deepEqual((await loadConfig(config, home)).agentCommand, [custom, ...suffix]);
  delete process.env.CATALY_AGENT_ARGV;
  process.env.CATALY_AGENT_CMD = managed;
  assert.deepEqual((await loadConfig(config, home)).agentCommand, [custom, ...suffix]);
  writeFileSync(config, JSON.stringify({ agentCommand: ["omp", ...suffix] }));
  for (const command of [custom, "env CUSTOM='owner value' custom-agent --flag"]) {
    process.env.CATALY_AGENT_CMD = command;
    assert.equal(defaultDeps().agentCmd, command);
    assert.deepEqual((await loadConfig(config, home)).agentCommand, [command, ...suffix]);
  }
  for (const raw of ["not json", "null", "{}", "[]", '["", "arg"]', '["omp", 1]', '"omp"']) {
    process.env.CATALY_AGENT_ARGV = raw;
    assert.throws(() => defaultDeps().agentCmd);
    await assert.rejects(loadConfig(config, home));
  }
}
console.log(JSON.stringify({ mode, checked: true }));
`;
    for (const mode of scenario === "normalization" ? ["foreign-home", "managed-commands"] : ["recovery"]) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          probe,
          join(release, "skills/cataly-mode/scripts/src/config.ts"),
          join(release, "src/harness.ts"),
          JSON.stringify(payload),
          mode,
        ],
        {
          timeout: 10_000,
          cwd: f.root,
          env: {
            HOME: mode === "foreign-home" ? join(f.root, "foreign-home") : f.paths.home,
            PATH: process.env["PATH"],
            CATALY_HOME: f.paths.cataly,
            CATALY_CONFIG: f.paths.config,
            CATALY_AGENT_CMD: managed,
            CATALY_TELEMETRY: "0",
          },
        },
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({ mode, checked: true });
    }
  },
  30_000,
);

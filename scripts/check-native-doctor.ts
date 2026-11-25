import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { consumerPaths } from "../src/release/files.ts";
import { publicReleasePath, validateReleaseManifest } from "../src/release/manifest.ts";
import { nativeDirectory } from "../src/release/native.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { manifestPath, releasePath } from "../src/release/state.ts";
import { probeNativeCli } from "../src/runtime/omp-capabilities.ts";
import { command } from "../src/update/deployment-process.ts";
import { sourceManifest } from "../src/update/source.ts";
import { releaseFixture } from "../test/release-producer-setup.ts";

const home = process.argv[2];
if (!home || !isAbsolute(home))
  throw new Error("Provide the absolute home containing the prepared pinned native source");
const root = resolve(import.meta.dir, "..");
const expected = readSourceBundle(root).lock;
const env = { HOME: home, PATH: process.env["PATH"] ?? "", LANG: "C.UTF-8", TERM: "dumb" };
const packageHome = mkdtempSync(join(tmpdir(), "cataly-native-release-"));
try {
  const paths = consumerPaths(home, join(packageHome, "cataly"));
  const files = sourceManifest(root).files.filter((file) => publicReleasePath(file.path));
  const template = releaseFixture(files);
  const manifest = validateReleaseManifest({ ...template, requirements: { omp: expected.nativeVersion } });
  const release = releasePath(paths, manifest);
  for (const file of files) {
    const to = join(release, file.path);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(root, file.path), to);
  }
  mkdirSync(paths.manifests, { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath(paths, manifest), JSON.stringify(manifest), { mode: 0o600 });
  if (existsSync(join(release, ".git"))) throw new Error("Packaged source must not have Git metadata");
  const native = nativeDirectory(root, home);
  for (const [label, loadedSource, agentCommand, observedRevision] of [
    ["native-cache", root, [join(native, "bin/omp")], expected.commit],
    ["consumer-wrapper", root, [join(root, "scripts/consumer/omp")], expected.commit],
    [
      "source-launcher",
      root,
      [
        process.execPath,
        "--preload",
        join(native, "source/packages/coding-agent/scripts/omp.ts"),
        join(native, "source/packages/coding-agent/src/cli.ts"),
      ],
      "unknown",
    ],
    [
      "timed-source-launcher",
      root,
      [
        process.execPath,
        "--preload",
        join(native, "source/packages/coding-agent/scripts/omp.ts"),
        "--preload",
        `${join(native, "source/packages/coding-agent")}/scripts/../../utils/src/module-timer.ts`,
        `${join(native, "source/packages/coding-agent")}/scripts/../src/cli.ts`,
      ],
      "unknown",
    ],
    ["packaged-release", release, [join(release, "scripts/consumer/omp")], expected.commit],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "cataly-native-doctor-"));
    try {
      const stateDir = join(dir, "state");
      mkdirSync(stateDir);
      const config = join(dir, "config.json");
      const body = JSON.stringify({
        stateDir,
        sessionsDir: join(dir, "sessions"),
        defaultCwd: root,
        leadPane: "",
        agentCommand,
        doctor: { ignore: ["runtime"] },
      });
      writeFileSync(config, body);
      const output = await command(
        [process.execPath, join(loadedSource, "skills/cataly-mode/scripts/src/cli.ts"), "doctor", "--json"],
        dir,
        {
          ...env,
          TMPDIR: dir,
          CATALY_CONFIG: config,
          CATALY_STATE_DIR: stateDir,
          CATALY_LEAD_PANE: "",
          CATALY_RUNTIME: "headless",
        },
        20_000,
      );
      const report = JSON.parse(output) as {
        findings: { detail: string; severity: string; provenance?: string }[];
      };
      const finding = report.findings.find((item) => item.provenance?.startsWith("native-cli "));
      if (
        finding?.severity === "WARN" ||
        !finding?.detail.includes(`observedRevision=${observedRevision}`) ||
        !finding.detail.includes("publicCLI=PASS")
      )
        throw new Error(`Native doctor did not validate ${label}: ${JSON.stringify(finding)}`);
      if (readFileSync(config, "utf8") !== body || readdirSync(stateDir).length !== 0)
        throw new Error(`Native doctor changed config or selected state for ${label}`);
      console.log(`NATIVE_DOCTOR_OK ${label} ${finding.detail}; config/state unchanged`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const releasedWrapper = join(release, "scripts/consumer/omp");
  writeFileSync(releasedWrapper, "#!/bin/sh\nprintf 'SDK shim\\n'\n");
  const rejected = await probeNativeCli([releasedWrapper], release, env, String(expected.nativeVersion), release);
  if (!rejected.reason?.includes("managed consumer release verification") || rejected.revision !== undefined)
    throw new Error(`Changed release wrapper was not held by its retained manifest: ${JSON.stringify(rejected)}`);
  console.log(`NATIVE_DOCTOR_REJECTED altered-release ${JSON.stringify(rejected)}`);

  // A tiny source fixture shares only the lock/patch identity, not a worktree or installed dependencies.
  const fixture = mkdtempSync(join(tmpdir(), "cataly-native-wrapper-"));
  try {
    for (const file of ["native-omp.lock", "native-omp.patch"]) copyFileSync(join(root, file), join(fixture, file));
    const wrapper = join(fixture, "scripts/consumer/omp");
    mkdirSync(join(fixture, "scripts/consumer"), { recursive: true });
    copyFileSync(join(root, "scripts/consumer/omp"), wrapper);
    const git = Bun.which("git");
    if (!git) throw new Error("Git is required for the native wrapper regression");
    const gitEnv = { ...env, HOME: fixture, TMPDIR: fixture, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const args of [
      ["init", "--quiet"],
      ["add", "scripts/consumer/omp"],
      [
        "-c",
        "user.name=betive37",
        "-c",
        "user.email=25229825+betive37@users.noreply.github.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ],
    ])
      await command([git, ...args], fixture, gitEnv, 5_000);
    writeFileSync(wrapper, "#!/bin/sh\nprintf 'SDK shim\\n'\n", { mode: 0o700 });
    const probe = await probeNativeCli([wrapper], fixture, env, String(expected.nativeVersion), fixture);
    if (
      probe.reason !== "configured consumer wrapper differs from the loaded Git revision" ||
      probe.revision !== undefined
    )
      throw new Error(`Altered wrapper was not rejected at its selected path: ${JSON.stringify(probe)}`);
    console.log(`NATIVE_DOCTOR_REJECTED altered-wrapper ${JSON.stringify(probe)}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
} finally {
  rmSync(packageHome, { recursive: true, force: true });
}

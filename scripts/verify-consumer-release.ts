import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { readArchive } from "../src/release/archive.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { createConsumerSmokeContext } from "./consumer-smoke-context.ts";
import { assertNativeExecutable, currentNativeHost, nativeHosts, nativeReleasePath } from "./release-native.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "working-tree": { type: "boolean" },
    out: { type: "string" },
    "tar-bin": { type: "string" },
  },
});
assert(
  values.source && values.out && isAbsolute(values.out),
  "Required: --source CANDIDATE --out FRESH_ABSOLUTE_DIR [--working-tree] [--tar-bin GNU_TAR]",
);
const source = realpathSync(values.source);
const host = currentNativeHost();
assert(host, "Requires Linux x64 or Darwin arm64");
const tar = values["tar-bin"] ?? Bun.which(process.platform === "darwin" ? "gtar" : "tar");
assert(tar, "A real GNU tar is required by the production release builder; supply --tar-bin");
const { out, side, tools, run, unchangedPrimary } = createConsumerSmokeContext(values.out, tar);
const bun = join(tools, "bun");
const git = join(tools, "git");
const cli = join(side, "bin/cataly");
const dist = join(out, "release");
const manifestFile = (dist: string) => join(dist, "release-manifest.json");
const readManifest = (dist: string) => validateReleaseManifest(JSON.parse(readFileSync(manifestFile(dist), "utf8")));

async function build(): Promise<void> {
  const clean = await run("clean-committed-snapshot", [git, "-C", source, "status", "--porcelain"]);
  assert.equal(clean.stdout, "");
  await run(
    "build-committed-release",
    [bun, join(source, "scripts/release.ts"), "build", "--out", dist, "--prerelease"],
    { producer: true },
  );
  const verify =
    "const {verifyDistribution}=await import(process.argv[1]); " +
    "console.log(JSON.stringify((await verifyDistribution(process.argv[2],process.argv[3])).manifest));";
  await run(
    "verify-committed-distribution",
    [bun, "-e", verify, join(source, "scripts/release-build.ts"), source, dist],
    { producer: true },
  );
}

assert.match((await run("gnu-tar", [join(tools, "tar"), "--version"])).stdout, /GNU tar/);
const working = values["working-tree"]
  ? JSON.parse(
      (
        await run(
          "package-working-candidate",
          [bun, join(source, "scripts/consumer-smoke-candidate.ts"), source, join(out, "candidate-tree"), dist],
          { producer: true },
        )
      ).stdout,
    )
  : undefined;
if (!working) await build();
const b = readManifest(dist);
assert.equal(b.tag, "v0.1.4");
// A local candidate rebuilds only this host's native binary; the public producer also receives the other host's.
const controllerPath = nativeReleasePath(host);
for (const other of nativeHosts.filter((entry) => entry !== host)) {
  const foreign = nativeReleasePath(other);
  assert(!b.source.files.some(({ path }) => path === foreign), `Local smoke unexpectedly bundles ${foreign}`);
}
assert(
  b.source.files.find(({ path }) => path === controllerPath)?.executable,
  "Release lacks an executable native controller",
);
const controller = readArchive(readFileSync(join(dist, b.archive.name)), b).find(({ path }) => path === controllerPath);
assert(controller, "Release lacks the native executable payload");
assertNativeExecutable(host, controller.bytes);

await run("fresh-bootstrap", [
  join(tools, "bash"),
  join(dist, "install.sh"),
  "--from",
  dist,
  "--version",
  b.tag,
  "--home",
  side,
]);
// The installed release activates the bundled binary for this host in its own source tree.
const installedController = join(side, "src", controllerPath);
accessSync(installedController, constants.X_OK);
assert(readFileSync(installedController).equals(controller.bytes), "Installed native controller differs");
const config = JSON.parse(readFileSync(join(side, "config.json"), "utf8"));
assert.equal(config.runtime, undefined);
assert.equal(config.sessionRuntime, undefined);
assert.equal(
  (await run("headless-native-version", [join(side, "bin/omp"), "--version"])).stdout.trim(),
  b.requirements.omp,
);
assert.equal(JSON.parse((await run("headless-status", [cli, "update", "status"])).stdout).installed.tag, b.tag);
try {
  await run("fresh-harness-up", [cli, "harness", "up"]);
  const { stdout } = await run("fresh-harness-status", [cli, "harness", "status"]);
  assert.match(stdout, /NATIVE lead headless:\S+ idle pid=\d+ session=\S+/);
  assert.match(stdout, /NATIVE duty headless:\S+ idle pid=\d+ session=\S+/);
} finally {
  await run("fresh-harness-stop", [cli, "harness", "stop"]);
}
await run("check-installed", [cli, "update", "check", "--from", dist]);
await run("reinstall", [cli, "update", "install", "--from", dist]);
await run("installed-native-bindings", [
  bun,
  join(import.meta.dir, "consumer-smoke-inspect.ts"),
  side,
  manifestFile(dist),
]);
await run("installed-harness-command", [
  bun,
  join(import.meta.dir, "consumer-smoke-harness.ts"),
  "--side",
  side,
  "--expected-source",
  realpathSync(join(side, "src")),
]);
unchangedPrimary();
writeFileSync(
  join(out, "result.json"),
  `${JSON.stringify({ b, working, runtime: "headless", platform: process.platform, arch: process.arch }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(`Consumer release checks completed; evidence: ${out}`);

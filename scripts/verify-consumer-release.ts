import assert from "node:assert/strict";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { processExists } from "../src/update/proc.ts";
import { digest } from "../src/update/source.ts";
import { createConsumerSmokeContext } from "./consumer-smoke-context.ts";
import { snapshot } from "./consumer-smoke-inspect.ts";

const { values } = parseArgs({
  options: {
    "source-a": { type: "string" },
    "source-b": { type: "string" },
    out: { type: "string" },
    "runtime-bin": { type: "string" },
    "tar-bin": { type: "string" },
  },
});
assert(
  values["source-a"] && values["source-b"] && values.out && values["runtime-bin"],
  "Required: --source-a BASELINE --source-b CANDIDATE --out FRESH_ABSOLUTE_DIR --runtime-bin REAL_BINARY [--tar-bin GNU_TAR]",
);
assert(isAbsolute(values.out) && isAbsolute(values["runtime-bin"]), "Output and runtime binary must be absolute");
const sourceA = realpathSync(values["source-a"]);
const sourceB = realpathSync(values["source-b"]);
const runtime = process.platform === "darwin" ? "hc" : "herdr";
assert(
  (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "darwin" && process.arch === "arm64"),
  "Requires Linux x64/herdr or Darwin arm64/hc",
);
const runtimeBin = realpathSync(values["runtime-bin"]);
const tar = values["tar-bin"] ?? Bun.which(process.platform === "darwin" ? "gtar" : "tar");
assert(tar, "A real GNU tar is required by the production release builder; supply --tar-bin");
const { out, side, tools, cwd, namespace, env, run, deriveCandidate, primary, unchangedPrimary } =
  createConsumerSmokeContext(values.out, runtime, runtimeBin, tar);
const bun = join(tools, "bun");
const cli = join(side, "bin/dori");
const manifestFile = (dist: string) => join(dist, "release-manifest.json");
const distA = join(out, "release-a");
const distB = join(out, "release-b");
let server: Subprocess | undefined;
let corePid: number | undefined;
let started = false;
async function until(what: string, probe: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
try {
  assert.match((await run("gnu-tar", [join(tools, "tar"), "--version"])).stdout, /GNU tar/);
  const version = (await run("runtime-version", [runtimeBin, "--version"])).stdout;
  assert.equal(version.match(/\b\d+\.\d+\.\d+\b/)?.[0], runtime === "hc" ? "0.1.20" : "0.9.5");
  const derivation = await deriveCandidate(sourceB);
  const manifests: ReleaseManifest[] = [];
  for (const [source, dist] of [
    [sourceA, distA],
    [derivation.checkout, distB],
  ] as const) {
    await run("clean-snapshot", [join(tools, "git"), "-C", source, "diff", "--exit-code", "HEAD", "--"]);
    await run("build", [bun, join(source, "scripts/release.ts"), "build", "--out", dist, "--prerelease"]);
    // Each producer is runtime-selected from its committed snapshot, including that snapshot's canonical version.
    const verify =
      "const {verifyDistribution}=await import(process.argv[1]); " +
      "console.log(JSON.stringify((await verifyDistribution(process.argv[2],process.argv[3])).manifest));";
    await run("verify-distribution", [bun, "-e", verify, join(source, "scripts/release-build.ts"), source, dist]);
    manifests.push(validateReleaseManifest(JSON.parse(readFileSync(manifestFile(dist), "utf8"))));
  }
  const a = manifests[0]!;
  const b = manifests[1]!;
  assert.equal(a.tag, "v0.1.2");
  assert.equal(a.commit, "74870017f361dad437ba5e4dd97c90698823a1f3", "Source A must be the supported PR54 baseline");
  assert.equal(b.tag, "v0.1.3");
  assert.equal(b.commit, derivation.qa);
  assert.notEqual(a.tag, b.tag, "Two genuine committed package versions are required; same-tag updates are held");
  for (const key of ["commit", "tree"] as const) assert.notEqual(a[key], b[key]);
  assert.notEqual(a.source.hash, b.source.hash);
  assert.notEqual(a.archive.sha256, b.archive.sha256);
  await run("ancestor", [
    join(tools, "git"),
    "-C",
    sourceB,
    "merge-base",
    "--is-ancestor",
    a.commit,
    derivation.candidate,
  ]);
  await run("bootstrap-a", [
    join(tools, "bash"),
    join(distA, "install.sh"),
    "--from",
    distA,
    "--version",
    a.tag,
    "--home",
    side,
    "--runtime",
    runtime,
  ]);
  const config = readFileSync(join(side, "config.json"));
  const wrappersA = snapshot(join(side, "bin"));
  const sourceBytesA = snapshot(realpathSync(join(side, "src")));
  const owner = readFileSync(join(side, "releases/consumer-owner.json"));
  const beforeRejection = snapshot(side);
  for (const kind of ["checksum", "manifest"] as const) {
    const bad = join(out, `rejected-${kind}`);
    cpSync(distB, bad, { recursive: true, errorOnExist: true, force: false });
    if (kind === "checksum") {
      const archive = join(bad, b.archive.name);
      writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("corrupt")]));
    } else {
      const bytes = `${JSON.stringify({ ...b, tag: "invalid-negative-test-tag" }, null, 2)}\n`;
      writeFileSync(manifestFile(bad), bytes);
      const sums = readFileSync(join(bad, "SHA256SUMS"), "utf8").replace(
        /^[a-f0-9]{64} {2}release-manifest\.json$/m,
        `${digest(bytes)}  release-manifest.json`,
      );
      writeFileSync(join(bad, "SHA256SUMS"), sums);
    }
    const rejected = await run(`reject-${kind}`, [cli, "update", "install", "--from", bad, "--version", b.tag], true);
    assert.equal(rejected.code, 2);
    assert.match(
      rejected.stderr,
      kind === "checksum" ? /Release checksum differs/ : /Release identity\/version\/tag\/commit\/tree is invalid/,
    );
    assert.equal(snapshot(side), beforeRejection, `${kind} rejection mutated prior state/config/wrappers`);
    unchangedPrimary();
  }
  if (runtime === "hc") {
    mkdirSync(join(out, "c/herdr-core"), { mode: 0o700 });
    writeFileSync(join(out, "c/herdr-core/config.toml"), "notes = false\n", { flag: "wx", mode: 0o600 });
    // Same private HC_SESSION/XDG mechanism as e2e-hc-setup.ts; no fixture agent or model is launched.
    await run("hc-start", [join(side, "bin/omp-dori"), "hc", "--json", "server", "start"]);
    started = true;
    const status = await run("hc-status", [join(side, "bin/omp-dori"), "hc", "--json", "server", "status"]);
    corePid = Number(JSON.parse(status.stdout).pid);
    assert(Number.isSafeInteger(corePid) && corePid > 0, "Private hc did not report its owned server PID");
  } else {
    const fd = openSync(join(out, "logs/herdr-server.log"), "wx", 0o600);
    try {
      server = Bun.spawn([runtimeBin, "--session", namespace, "server"], { cwd, env, stdout: fd, stderr: fd });
    } finally {
      closeSync(fd);
    }
    started = true;
    await until(
      "private herdr readiness",
      async () =>
        (await run("herdr-ready", [runtimeBin, "--session", namespace, "workspace", "list"], true)).code === 0,
    );
  }
  async function inspect(dist: string, previous: string) {
    const expected = validateReleaseManifest(JSON.parse(readFileSync(manifestFile(dist), "utf8")));
    const status = JSON.parse((await run("installed-status", [cli, "update", "status"])).stdout);
    assert.deepEqual(status.installed, {
      tag: expected.tag,
      commit: expected.commit,
      sourceHash: expected.source.hash,
      prerelease: expected.prerelease,
    });
    assert.equal((await run("shipped-cli-version", [cli, "--version"])).stdout.trim(), expected.releaseVersion);
    await run("installed-bindings", [
      bun,
      join(import.meta.dir, "consumer-smoke-inspect.ts"),
      side,
      manifestFile(dist),
      previous === "-" ? "-" : manifestFile(previous),
      runtime,
    ]);
    const native = await run("native-version", [join(side, "bin/omp"), "--version"]);
    assert.match(native.stdout, /\b18\.20\.0\b/);
    assert(readFileSync(join(side, "config.json")).equals(config), "Selected runtime/config bytes changed");
    assert(readFileSync(join(side, "releases/consumer-owner.json")).equals(owner), "Consumer ownership changed");
    unchangedPrimary();
  }
  await inspect(distA, "-");
  const check = await run("check-b", [cli, "update", "check", "--from", distB, "--version", b.tag]);
  assert.deepEqual(JSON.parse(check.stdout), {
    available: b.tag,
    commit: b.commit,
    sourceHash: b.source.hash,
    prerelease: b.prerelease,
    installed: a.tag,
    change: true,
  });
  await run("update-b", [cli, "update", "install", "--from", distB, "--version", b.tag]);
  await inspect(distB, distA);
  // A's historical updater selects B but still renders A's wrapper. B must publish its own launch hook.
  const hasLaunchHook = () =>
    readFileSync(join(side, "bin/omp"), "utf8").includes('"$source/src/release/automatic.ts"');
  assert.equal(hasLaunchHook(), false, "The historical A updater unexpectedly published a newer launch hook");
  await run("reinstall-b-references", [cli, "update", "install", "--from", distB, "--version", b.tag]);
  await inspect(distB, distA);
  assert.equal(hasLaunchHook(), true, "B same-release reinstall did not publish its automatic launch hook");
  await run("adopted-b-harness", [
    bun,
    join(import.meta.dir, "consumer-smoke-harness.ts"),
    "--side",
    side,
    "--expected-source",
    join(side, "releases/releases", `${b.commit}-${b.source.hash.slice(0, 16)}`),
  ]);
  await run("rollback-a", [cli, "update", "rollback", "--version", a.tag]);
  await inspect(distA, distB);
  assert.equal(snapshot(join(side, "bin")), wrappersA, "Rollback did not restore exact A wrapper bytes/modes");
  assert.equal(snapshot(realpathSync(join(side, "src"))), sourceBytesA, "Rollback did not restore exact A source");
  writeFileSync(
    join(out, "identities.json"),
    `${JSON.stringify(
      { a, b, derivation, runtime, namespace, runtimeBin, runtimeHash: digest(readFileSync(runtimeBin)), primary },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
} finally {
  if (started && runtime === "hc") {
    await run("hc-stop", [join(side, "bin/omp-dori"), "hc", "--json", "server", "stop"]);
    assert(corePid, "Private hc ownership PID was not established; inspect retained evidence");
    await until("owned hc exit", async () => !processExists(corePid!));
    assert(!existsSync(join(out, "r/herdr-core", `${namespace}.sock`)), "Private hc socket survived stop");
  } else if (started && server) {
    await run("herdr-stop", [runtimeBin, "--session", namespace, "server", "stop"]);
    assert.equal(await server.exited, 0, "Owned private herdr server failed");
  }
  unchangedPrimary();
}
writeFileSync(
  join(out, "result.json"),
  `${JSON.stringify(
    { ok: true, platform: process.platform, arch: process.arch, runtime, namespace, evidence: out },
    null,
    2,
  )}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(`Version-derived consumer upgrade/rollback and rejection checks completed; evidence: ${out}`);

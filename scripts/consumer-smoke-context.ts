import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { digest } from "../src/update/source.ts";
import { snapshot } from "./consumer-smoke-inspect.ts";

/** All writes and all child selections belong to one explicitly selected, previously nonexistent namespace. */
export function createConsumerSmokeContext(rawOut: string, runtime: string, runtimeBin: string, tar: string) {
  const out = join(realpathSync(dirname(rawOut)), basename(rawOut));
  assert(!lstatSync(out, { throwIfNoEntry: false }), "Output namespace must not exist");
  for (const name of [".dori", ".omp-dori", ".omp", ".agents", ".config", ".cache", ".local", ".bun"]) {
    const path = join(homedir(), name);
    if (!existsSync(path)) continue;
    const within = relative(realpathSync(path), out);
    assert(within === ".." || within.startsWith(`..${sep}`), `Output must be outside the real ${name}`);
  }
  const home = join(out, "consumer-home");
  const side = join(home, ".omp-dori");
  const tools = join(out, "tools");
  const cwd = join(out, "workspace");
  const namespace = `omp-dori-${digest(side).slice(0, 12)}`;
  // Use the real E2E harness's conservative socket budget, with the actual supplied root (no fallback namespace).
  assert(
    Buffer.byteLength(join(out, "r/herdr-core", `${namespace}.holder.00000000.sock`)) <= 100,
    "Private runtime socket path is too long; supply a shorter --out path",
  );
  mkdirSync(out, { mode: 0o700 });
  for (const path of [
    home,
    tools,
    cwd,
    join(out, "logs"),
    join(out, "tmp"),
    join(out, "s"),
    join(out, "r"),
    join(out, "c"),
  ]) {
    mkdirSync(path, { mode: 0o700 });
  }
  const binaries = {
    bun: process.execPath,
    [runtime]: runtimeBin,
    tar,
    git: Bun.which("git"),
    gzip: Bun.which("gzip"),
    bash: Bun.which("bash"),
  };
  for (const [name, path] of Object.entries(binaries)) {
    assert(path, `Missing prerequisite: ${name}`);
    symlinkSync(realpathSync(path), join(tools, name));
  }
  // An allowlist, not a spread: no inherited DORI/HC/HERDR/OMP selection, credentials or provider settings cross.
  const env = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LC_ALL: "C",
    TZ: "UTC",
    TMPDIR: join(out, "tmp"),
    XDG_STATE_HOME: join(out, "s"),
    XDG_RUNTIME_DIR: join(out, "r"),
    XDG_CONFIG_HOME: join(out, "c"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    HC_SESSION: namespace,
    DORI_HERDR_SESSION: namespace,
    DORI_HOME: side,
    DORI_CONFIG: join(side, "config.json"),
    DORI_INSTALL_MODE: "side",
    DORI_TELEMETRY: "0",
    GIT_MASTER: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  let sequence = 0;
  async function run(label: string, argv: string[], allowFailure = false) {
    const child = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 1_200_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = { argv, cwd, code, signal: child.signalCode, stdout, stderr };
    const log = join(out, "logs", `${++sequence}-${label}.json`);
    writeFileSync(log, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ label, argv, cwd, code, signal: child.signalCode, log }));
    for (const [stream, text] of Object.entries({ stdout, stderr })) {
      console.log(
        JSON.stringify({ label, stream, total: text.length, bytes: Buffer.byteLength(text), sha256: digest(text) }),
      );
      for (let offset = 0; offset < text.length; offset += 2048) {
        console.log(JSON.stringify({ label, stream, offset, chunk: text.slice(offset, offset + 2048) }));
      }
    }
    assert(allowFailure || code === 0, `${label} failed (${code}); evidence: ${log}`);
    return result;
  }
  async function deriveCandidate(source: string) {
    const git = join(tools, "git");
    await run("clean-candidate", [git, "-C", source, "diff", "--exit-code", "HEAD", "--"]);
    const candidate = (await run("candidate-commit", [git, "-C", source, "rev-parse", "HEAD"])).stdout.trim();
    const candidateTree = (await run("candidate-tree", [git, "-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    const checkout = join(out, "candidate-qa-source");
    await run("clone-private-candidate", [
      git,
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--no-tags",
      "--",
      source,
      checkout,
    ]);
    await run("select-private-candidate", [git, "-C", checkout, "switch", "--detach", candidate]);
    const packageFile = join(checkout, "package.json");
    const before = readFileSync(packageFile, "utf8");
    const from = JSON.parse(before).version;
    assert.equal(from, "0.1.2", "This bounded QA derivation requires the canonical candidate version 0.1.2");
    // releases.md and release/version.ts define only this root field as canonical; no bump script exists.
    const oldField = '  "version": "0.1.2",';
    const newField = '  "version": "0.1.3",';
    assert.equal(before.split(oldField).length, 2, "Canonical version field must have one exact occurrence");
    const after = before.replace(oldField, newField);
    assert.deepEqual({ ...JSON.parse(after), version: from }, JSON.parse(before));
    writeFileSync(packageFile, after);
    await run("stage-private-version", [git, "-C", checkout, "add", "--", "package.json"]);
    const staged = await run("private-version-scope", [git, "-C", checkout, "diff", "--cached", "--name-only"]);
    assert.equal(staged.stdout.trim(), "package.json");
    await run("commit-private-version", [
      git,
      "-C",
      checkout,
      "-c",
      "user.name=OMP-Dori consumer smoke",
      "-c",
      "user.email=consumer-smoke@localhost",
      "commit",
      "-m",
      "test: derive private consumer smoke version 0.1.3",
    ]);
    const qa = (await run("qa-commit", [git, "-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
    const qaTree = (await run("qa-tree", [git, "-C", checkout, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    assert.equal((await run("qa-parent", [git, "-C", checkout, "rev-parse", "HEAD^"])).stdout.trim(), candidate);
    const original = await run("candidate-inventory", [git, "-C", checkout, "ls-tree", "-r", "-z", candidate]);
    const derived = await run("qa-inventory", [git, "-C", checkout, "ls-tree", "-r", "-z", qa]);
    const originalRows = original.stdout.split("\0").filter(Boolean);
    const derivedRows = derived.stdout.split("\0").filter(Boolean);
    const nonVersion = (row: string) => row.slice(row.indexOf("\t") + 1) !== "package.json";
    assert.deepEqual(
      derivedRows.filter(nonVersion),
      originalRows.filter(nonVersion),
      "QA derivation changed non-version tracked blob bytes, Git modes or paths",
    );
    const beforeEntry = originalRows.filter((row) => !nonVersion(row));
    const afterEntry = derivedRows.filter((row) => !nonVersion(row));
    assert.equal(beforeEntry.length, 1);
    assert.equal(afterEntry.length, 1);
    assert.equal(beforeEntry[0]!.split(" ").slice(0, 2).join(" "), "100644 blob");
    assert.equal(afterEntry[0]!.split(" ").slice(0, 2).join(" "), "100644 blob");
    const committedPackage = await run("qa-package-bytes", [git, "-C", checkout, "show", `${qa}:package.json`]);
    assert.equal(committedPackage.stdout, after);
    const clean = await run("qa-clean", [git, "-C", checkout, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(clean.stdout, "");
    const delta = await run("qa-version-delta", [
      git,
      "-C",
      checkout,
      "diff",
      "--binary",
      "--full-index",
      candidate,
      qa,
      "--",
      "package.json",
    ]);
    writeFileSync(join(out, "qa-version.patch"), delta.stdout, { flag: "wx", mode: 0o600 });
    const proof = {
      candidate,
      candidateTree,
      qa,
      qaTree,
      checkout,
      from,
      to: "0.1.3",
      changedPaths: ["package.json"],
      nonVersionInventoryHash: digest(originalRows.filter(nonVersion).join("\0")),
      statement: "Runtime source B is a private metadata-only version derivation, not raw final-candidate bytes.",
    };
    writeFileSync(join(out, "qa-derivation.json"), `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return proof;
  }
  for (const [name, bytes] of Object.entries({
    ".dori/config.json": '{"sentinel":"primary-config"}\n',
    ".dori/releases/consumer-owner.json": '{"sentinel":"primary-owner"}\n',
    ".dori/bin/dori": "primary wrapper sentinel\n",
    ".agents/skills/dori-mode/SKILL.md": "primary discovery sentinel\n",
    ".omp/agent/extensions/primary/sentinel.txt": "primary extension sentinel\n",
  })) {
    mkdirSync(dirname(join(home, name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, name), bytes, { flag: "wx", mode: 0o600 });
  }
  const primaryRoots = [join(home, ".dori"), join(home, ".agents"), join(home, ".omp")];
  const primary = primaryRoots.map(snapshot);
  const unchangedPrimary = () => assert.deepEqual(primaryRoots.map(snapshot), primary, "Primary sentinel tree changed");
  writeFileSync(
    join(out, "namespace.json"),
    `${JSON.stringify({ out, home, side, namespace, env, primary }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { out, home, side, tools, cwd, namespace, env, run, deriveCandidate, primary, unchangedPrimary };
}

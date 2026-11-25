import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { digest } from "../src/update/source.ts";

const { values, positionals } = parseArgs({
  options: {
    side: { type: "string" },
    "expected-source": { type: "string" },
    "exec-boundary": { type: "boolean" },
  },
  allowPositionals: true,
});
assert(values.side && values["expected-source"], "Required: --side PRIVATE_SIDE --expected-source PHYSICAL_RELEASE");
const side = values.side;
const source = values["expected-source"];
assert(isAbsolute(side) && isAbsolute(source), "Side and expected physical source must be absolute");
assert.equal(realpathSync(side), side, "Side must be the explicit physical consumer home");
assert.equal(realpathSync(source), source, "Expected source must be physical, not the live alias");
const home = dirname(side);
const context = JSON.parse(readFileSync(join(dirname(home), "namespace.json"), "utf8"));
assert.equal(context.home, home, "Harness observer requires the driver's private namespace receipt");
assert.equal(context.side, side);
const bun = realpathSync(join(context.out, "tools/bun"));
assert.equal(process.execPath, bun, "Harness observer must use the admitted real Bun");
const manifest = validateReleaseManifest(
  JSON.parse(readFileSync(join(side, "releases/consumer-manifests", `${basename(source)}.json`), "utf8")),
);
assert.equal(source, join(side, "releases/releases", `${manifest.commit}-${manifest.source.hash.slice(0, 16)}`));
assert.equal(realpathSync(join(side, "src")), source, "Installed source differs from the explicitly expected release");
assert.deepEqual(JSON.parse(readFileSync(join(side, "releases/consumer-installed.json"), "utf8")).current, manifest);
assert.equal(manifest.requirements.omp, readSourceBundle(source).lock.nativeVersion);
const harness = manifest.source.files.find((file) => file.path === "src/harness.ts");
assert(harness, "Admitted release must contain its actual harness");
const harnessHash = digest(readFileSync(join(source, harness.path)));
assert.equal(harnessHash, harness.sha256);
const cwd = join(context.out, "workspace");
const sentinels = ["injected", "inherited-command-ran", "selected-command-ran", "substitution-ran", "suffix-ran"];
for (const name of sentinels) assert(!existsSync(join(cwd, name)), `Injection sentinel exists: ${name}`);
const forwarded = ["--consumer-smoke-boundary", "literal 'quote';$(touch injected)", ""];
const explicitRuntime = "headless";

if (!values["exec-boundary"]) {
  assert.equal(positionals.length, 0, "Observer accepts no implicit arguments");
  // Source the installed wrapper unchanged; intercept only its final exec, never its resolver or role logic.
  const shell = `set -euo pipefail
observer_bun=$1
observer_script=$2
observer_side=$3
observer_source=$4
shift 4
exec() {
  builtin exec "$observer_bun" "$observer_script" --exec-boundary --side "$observer_side" --expected-source "$observer_source" -- "$@"
}
source "$observer_side/bin/cataly-harness" "$@"
`;
  const child = Bun.spawn(
    [
      join(context.out, "tools/bash"),
      "-c",
      shell,
      "consumer-smoke-harness",
      bun,
      import.meta.path,
      side,
      source,
      ...forwarded,
    ],
    {
      cwd,
      env: {
        ...context.env,
        CATALY_HOME: join(home, ".cataly"),
        CATALY_CONFIG: join(home, ".cataly/config.json"),
        CATALY_AGENT_CMD: "touch inherited-command-ran",
        CATALY_AGENT_ARGV: '["touch","selected-command-ran"]',
        CATALY_STATE_DIR: "foreign-state",
        CATALY_RUNTIME: explicitRuntime,
        CATALY_PROMPTS_DIR: "foreign-prompts",
        CATALY_MANAGED_STARTUP: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  for (const name of sentinels) assert(!existsSync(join(cwd, name)), `Injection sentinel exists: ${name}`);
  assert.equal(code, 0, `Installed wrapper/harness boundary failed (${child.signalCode ?? "no signal"})`);
} else {
  assert.equal(process.cwd(), cwd);
  assert.deepEqual(
    positionals,
    [bun, join(side, "src/src/cli.ts"), ...forwarded],
    "Original final Bun/entrypoint/argv differs",
  );
  assert.equal(process.env["HOME"], home);
  assert.equal(process.env["CATALY_HOME"], side);
  assert.equal(process.env["CATALY_CONFIG"], join(side, "config.json"));
  assert.equal(process.env["CATALY_AGENT_CMD"], join(side, "bin/omp"), "Bound agent command was not exported");
  assert.equal(
    process.env["CATALY_RUNTIME"],
    explicitRuntime,
    "Explicit execution selection did not cross the wrapper",
  );
  const cleared = ["CATALY_AGENT_ARGV", "CATALY_STATE_DIR", "CATALY_PROMPTS_DIR", "CATALY_MANAGED_STARTUP"];
  for (const key of cleared) assert.equal(process.env[key], undefined, `Foreign ${key} crossed the wrapper`);
  const discovery = join(side, "releases/consumer-discovery", basename(source), "omp.yml");
  assert(lstatSync(discovery).isFile(), "The admitted physical release's discovery config is missing");
  const expected = [
    join(source, "scripts/consumer/omp"),
    "--no-extensions",
    "-e",
    join(source, "extension"),
    "--config",
    join(side, "omp.yml"),
    "--config",
    discovery,
  ];
  // Static imports cannot observe the installed physical release's actual default source root.
  const { defaultDeps, agentCommand } = await import(join(source, "src/harness.ts"));
  const deps = defaultDeps();
  assert.equal(deps.store.root, side);
  console.log(
    JSON.stringify({
      source,
      harnessHash,
      original: positionals,
      agent: process.env["CATALY_AGENT_CMD"],
      command: deps.agentCmd,
    }),
  );
  const roles: Record<string, { command: string; argv: string[] }> = {};
  for (const role of ["cataly", "lane"]) {
    const command: string = agentCommand(deps, role);
    // Decode literal shell words without eval, substitutions, expansion, or executing the native/model agent.
    const argv: string[] = [];
    let word = "";
    let quoted = false;
    let started = false;
    for (let at = 0; at < command.length; at++) {
      const char = command[at]!;
      if (quoted) {
        if (char === "'") quoted = false;
        else word += char;
      } else if (char === "'") {
        quoted = true;
        started = true;
      } else if (char === "\\") {
        assert(at + 1 < command.length, "Unterminated shell escape");
        word += command[++at]!;
        started = true;
      } else if (/\s/.test(char)) {
        if (started) argv.push(word);
        word = "";
        started = false;
      } else {
        assert(!'"`$;&|<>()*?[]{}!~'.includes(char), "Harness command contains non-literal shell syntax");
        word += char;
        started = true;
      }
    }
    assert(!quoted, "Unterminated shell quote");
    if (started) argv.push(word);
    assert.deepEqual(argv, [...expected, "--cataly-role", role], `Physical ${role} argv differs`);
    for (const once of [
      expected[0],
      "--no-extensions",
      "-e",
      join(source, "extension"),
      discovery,
      "--cataly-role",
      role,
    ])
      assert.equal(argv.filter((part) => part === once).length, 1, `Duplicated ${once}`);
    assert.equal(argv.filter((part) => part === "--config").length, 2);
    roles[role] = { command, argv };
  }
  for (const name of sentinels) assert(!existsSync(join(cwd, name)), `Injection sentinel exists: ${name}`);
  console.log(JSON.stringify({ source, expected, roles, home, config: process.env["CATALY_CONFIG"], cleared }));
}

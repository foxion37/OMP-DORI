import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { validateReleaseManifest } from "../src/release/manifest.ts";
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
assert.equal(manifest.requirements.omp, "18.20.0");
const harness = manifest.source.files.find((file) => file.path === "src/harness.ts");
assert(harness, "Admitted release must contain its actual harness");
const harnessHash = digest(readFileSync(join(source, harness.path)));
assert.equal(harnessHash, harness.sha256);
const cwd = join(context.out, "workspace");
const sentinels = ["injected", "inherited-command-ran", "selected-command-ran", "substitution-ran", "suffix-ran"];
for (const name of sentinels) assert(!existsSync(join(cwd, name)), `Injection sentinel exists: ${name}`);
const forwarded = ["--consumer-smoke-boundary", "literal 'quote';$(touch injected)", ""];

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
source "$observer_side/bin/dori-harness" "$@"
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
        DORI_HOME: join(home, ".dori"),
        DORI_CONFIG: join(home, ".dori/config.json"),
        DORI_AGENT_CMD: "touch inherited-command-ran",
        DORI_AGENT_ARGV: '["touch","selected-command-ran"]',
        DORI_STATE_DIR: "foreign-state",
        DORI_RUNTIME: "foreign-runtime",
        DORI_LEAD_PANE: "foreign-lead",
        DORI_HC_SPACE: "foreign-space",
        DORI_PROMPTS_DIR: "foreign-prompts",
        DORI_OMP_ULW_PATH: "/foreign/ulw/index.ts",
        DORI_MANAGED_STARTUP: "1",
        HC_SESSION: "foreign-session",
        HC_TERMINAL_ID: "foreign-terminal",
        HC_TERMINAL_SOCKET: "foreign-terminal-socket",
        HC_SOCKET: "foreign-socket",
        DORI_HERDR_SESSION: "foreign-session",
        HERDR_PANE_ID: "foreign-pane",
        HERDR_WORKSPACE_ID: "foreign-workspace",
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
  assert.equal(process.env["DORI_HOME"], side);
  assert.equal(process.env["DORI_CONFIG"], join(side, "config.json"));
  assert.equal(process.env["DORI_AGENT_CMD"], join(side, "bin/omp"), "Raw managed legacy export changed");
  const cleared = [
    "DORI_AGENT_ARGV",
    "DORI_STATE_DIR",
    "DORI_RUNTIME",
    "DORI_LEAD_PANE",
    "DORI_HC_SPACE",
    "DORI_PROMPTS_DIR",
    "DORI_OMP_ULW_PATH",
    "DORI_MANAGED_STARTUP",
    "HC_TERMINAL_ID",
    "HC_TERMINAL_SOCKET",
    "HC_SOCKET",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
  ];
  for (const key of cleared) assert.equal(process.env[key], undefined, `Foreign ${key} crossed the wrapper`);
  const namespace = `omp-dori-${digest(side).slice(0, 12)}`;
  assert.equal(process.env["HC_SESSION"], namespace);
  assert.equal(process.env["DORI_HERDR_SESSION"], namespace);
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
      agent: process.env["DORI_AGENT_CMD"],
      command: deps.agentCmd,
    }),
  );
  const roles: Record<string, { command: string; argv: string[] }> = {};
  for (const role of ["dori", "lane"]) {
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
    assert.deepEqual(argv, [...expected, "--dori-role", role], `Physical ${role} argv differs`);
    for (const once of [
      expected[0],
      "--no-extensions",
      "-e",
      join(source, "extension"),
      discovery,
      "--dori-role",
      role,
    ])
      assert.equal(argv.filter((part) => part === once).length, 1, `Duplicated ${once}`);
    assert.equal(argv.filter((part) => part === "--config").length, 2);
    roles[role] = { command, argv };
  }
  for (const name of sentinels) assert(!existsSync(join(cwd, name)), `Injection sentinel exists: ${name}`);
  console.log(
    JSON.stringify({ source, expected, roles, home, config: process.env["DORI_CONFIG"], cleared, namespace }),
  );
}

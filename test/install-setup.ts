import { afterEach, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The miniature checkout exposes the real reader without copying the full application into every fixture.
const fixtureReader = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/config.ts");

// POSIX-only: this installer fixture runs shell scripts, links and mode checks the Windows host cannot exercise.
export const posix = test.skipIf(process.platform === "win32");

// The real source installer over a local upstream; package installs and toolchain probes stay isolated.
export const script = resolve(import.meta.dir, "../scripts/install-source.sh");
const gitEnv: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
for (const key of Object.keys(gitEnv)) {
  if (/^(?:OMP_)?CATALY_/.test(key)) delete gitEnv[key];
}
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

export const git = (cwd: string, ...argv: string[]): string => {
  const r = Bun.spawnSync(["git", ...argv], { cwd, env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const skillFixture = "---\nname: cataly-mode\ndescription: Turns a coding agent into a Cataly.\n---\n\n# Cataly mode\n";

export function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-install-")));
  roots.push(root);
  const upstream = join(root, "upstream");
  const src = join(root, "src");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const cli = "skills/cataly-mode/scripts/src/cli.ts";
  mkdirSync(join(upstream, "skills/cataly-mode/scripts/src"), { recursive: true });
  mkdirSync(join(upstream, "skills/cataly-mode/references"), { recursive: true });
  mkdirSync(join(upstream, "extension"));
  mkdirSync(join(upstream, "scripts"));
  symlinkSync(
    resolve(import.meta.dir, "../scripts/source-dependencies.ts"),
    join(upstream, "scripts/source-dependencies.ts"),
  );
  // The installer's one-way bridge from previous installations, run from the checkout being installed.
  symlinkSync(resolve(import.meta.dir, "../scripts/previous-install"), join(upstream, "scripts/previous-install"));
  writeFileSync(join(upstream, "extension/index.ts"), "export default () => {};\n");
  writeFileSync(join(upstream, cli), "v1\n");
  writeFileSync(
    join(upstream, "skills/cataly-mode/scripts/src/config.ts"),
    `export * from ${JSON.stringify(fixtureReader)};\n`,
  );
  // Marks a Cataly checkout; an explicit CATALY_OMP never reads this unbound placeholder lock.
  writeFileSync(join(upstream, "native-omp.lock"), "{}\n");
  writeFileSync(join(upstream, "skills/cataly-mode/SKILL.md"), skillFixture);
  writeFileSync(join(upstream, "skills/cataly-mode/references/config.example.json"), "{}\n");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "v1");
  git(root, "clone", "-q", upstream, src);
  mkdirSync(home);
  mkdirSync(bin);
  // Record package-manager mutations without installing or linking anything on the host.
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh\ncase "$1" in\n--version) echo "\${INSTALL_TEST_BUN_VERSION:-1.4.4}" ;;\n-e|*/source-dependencies.ts|*/source-configuration.ts|*/previous-install/cli.ts|*/skills/cataly-mode/scripts/src/cli.ts) exec ${JSON.stringify(process.execPath)} "$@" ;;\n*) echo "$*" >> ${JSON.stringify(join(root, "bun.log"))} ;;\nesac\n`,
  );
  chmodSync(join(bin, "bun"), 0o755);
  writeFileSync(
    join(bin, "omp"),
    `#!/bin/sh\ncase "$1" in\n--version) echo "omp \${INSTALL_TEST_OMP_VERSION:-19.0.1}" ;;\n*) exit 64 ;;\nesac\n`,
  );
  chmodSync(join(bin, "omp"), 0o755);
  const upstreamCommit = (text: string) => {
    writeFileSync(join(upstream, cli), text);
    git(upstream, "commit", "-qam", text.trim());
  };
  const env = (extra: Record<string, string | undefined> = {}) => ({
    ...gitEnv,
    HOME: home,
    BUN_INSTALL: join(home, ".bun"),
    CATALY_HOME: undefined,
    CATALY_CONFIG: undefined,
    CATALY_STATE_DIR: undefined,
    CATALY_LEAD_PANE: undefined,
    CATALY_RUNTIME: undefined,
    CATALY_AGENT_ARGV: undefined,
    CATALY_AGENT_CMD: undefined,
    CATALY_AGENT_EXECUTABLE: undefined,
    CATALY_INSTALL_MODE: "",
    CATALY_NO_PULL: "",
    CATALY_SRC: src,
    CATALY_OMP: join(bin, "omp"),
    SKILLS_DIR: join(home, "skills"),
    OMP_EXTENSIONS_DIR: join(home, "extensions"),
    INSTALL_TEST_OMP_VERSION: "",
    OMP_CATALY_HOME: join(home, ".omp-cataly"),
    OMP_CATALY_BIN_DIR: join(home, "global-bin"),
    PATH: `${bin}:${process.env["PATH"]}`,
    ...extra,
  });
  const install = (extra: Record<string, string | undefined> = {}, argv: readonly string[] = []) => {
    const r = Bun.spawnSync([script, ...argv], { env: env(extra), stdin: "ignore" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { root, upstream, src, home, cli, upstreamCommit, env, install };
}

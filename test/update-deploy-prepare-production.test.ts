import { expect, test } from "bun:test";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareRelease } from "../src/update/deployment-prepare.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit } from "./source-bundle-setup.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";
import { git } from "./update-setup.ts";

const PACKAGES = ["", "skills/dori-mode/scripts", "extension"] as const;
const FROZEN = ["install", "--frozen-lockfile", "--ignore-scripts", "--silent"];
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Root and skill runtimes import no devDependency (gate tools only); the extension keeps its complete host install.
// The deployment fixture invokes an executable POSIX shell shim through a private install.
const posix = test.skipIf(process.platform === "win32");
posix.each([true, false])(
  "preparation skips root/skill dev tools (runtime deps: %s)",
  async (runtimeDeps) => {
    const f = preparationFixture();
    for (const relative of PACKAGES) {
      const prefix = relative ? `${relative}/` : "";
      f.put(`${prefix}fixture-dev/package.json`, '{"name":"fixture-dev","version":"1.0.0","type":"module"}');
      f.put(`${prefix}fixture-dev/index.ts`, "export const gateTool = 1;\n");
      const manifest = JSON.parse(readFileSync(join(f.remote, `${prefix}package.json`), "utf8"));
      const devDependencies = { "fixture-dev": "file:./fixture-dev" };
      const dependencies = runtimeDeps || relative === "extension" ? manifest.dependencies : {};
      f.put(`${prefix}package.json`, JSON.stringify({ ...manifest, dependencies, devDependencies }));
      const locked = Bun.spawnSync([process.execPath, "install", "--ignore-scripts", "--silent"], {
        cwd: join(f.remote, relative),
        env: { HOME: join(f.directory, "build-home"), PATH: process.env["PATH"] },
        stdout: "ignore",
        stderr: "pipe",
      });
      if (locked.exitCode !== 0) throw new Error(locked.stderr.toString());
      expect(readFileSync(join(f.remote, `${prefix}bun.lock`), "utf8")).toContain("fixture-dev");
      git(f.remote, "add", "--", `${prefix}package.json`, `${prefix}bun.lock`, `${prefix}fixture-dev`);
    }
    git(f.remote, "commit", "-m", "Add a development-only dependency to every package");
    fixtureGit(f.candidate, "fetch", "origin");
    fixtureGit(f.candidate, "checkout", "--detach", git(f.remote, "rev-parse", "HEAD"));
    const full = sourceManifest(f.candidate);
    const input = {
      ...f.input,
      commit: git(f.remote, "rev-parse", "HEAD"),
      tree: git(f.remote, "rev-parse", "HEAD^{tree}"),
      publicManifest: sourceManifest(f.remote),
      sourceHash: full.hash,
    };
    const record = { ...f.record, commit: input.commit, tree: input.tree, sourceHash: full.hash };
    // Records each install's physical cwd and argv (tab-separated, one line per call), then runs the real Bun.
    const log = join(f.directory, "install-argv.log");
    const bun = join(f.directory, "recording-bun");
    // Preparation intentionally admits only the selected Bun directory and system tools.
    // Keep the real Git reachable on hosts where Git is installed only in a user directory.
    const gitBinary = Bun.which("git");
    if (!gitBinary) throw new Error("Git is required for real deployment preparation");
    symlinkSync(gitBinary, join(f.directory, "git"));
    writeFileSync(
      bun,
      `#!/bin/sh
if [ "$1" = install ]; then
  { printf '%s' "$(pwd -P)"; for arg in "$@"; do printf '\\t%s' "$arg"; done; printf '\\n'; } >> ${quote(log)}
fi
exec ${quote(process.execPath)} "$@"
`,
      { mode: 0o755 },
    );
    await prepareRelease({ ...f.config, bun }, input, record);
    const calls = readFileSync(log, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(calls).toEqual([
      [record.releasePath, ...FROZEN, "--production"],
      [join(record.releasePath, "skills/dori-mode/scripts"), ...FROZEN, "--production"],
      [join(record.releasePath, "extension"), ...FROZEN],
    ]);
    const linked = (relative: string, name: string): boolean =>
      lstatSync(join(record.releasePath, relative, "node_modules", name), { throwIfNoEntry: false }) !== undefined;
    for (const relative of PACKAGES) {
      expect([relative, linked(relative, "fixture-dep")]).toEqual([relative, runtimeDeps || relative === "extension"]);
      expect([relative, linked(relative, "fixture-dev")]).toEqual([relative, relative === "extension"]);
    }
    expect(sourceManifest(record.releasePath).hash).toBe(full.hash);
    expect(sourceManifest(f.candidate)).toEqual(full);
  },
  30_000,
);

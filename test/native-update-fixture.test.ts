import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PINS } from "../src/release/native-update-dependencies.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

/** Synthetic npm metadata exercises pin admission only, not package integrity or native runtime compatibility. */
export function fixtureDependencyFiles(source: string, output: string, previous: string, next: string) {
  for (const [directory, section, name] of NATIVE_PINS) {
    mkdirSync(join(output, directory), { recursive: true, mode: 0o700 });
    const manifest = JSON.parse(readFileSync(join(source, directory, "package.json"), "utf8"));
    if (manifest[section][name] !== previous) throw new Error("Unexpected fixture pin");
    manifest[section][name] = next;
    writeFileSync(join(output, directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const workspace = Object.fromEntries(
      ["name", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .filter((key) => manifest[key] !== undefined)
        .map((key) => [key, manifest[key]]),
    );
    writeFileSync(
      join(output, directory, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 2,
        configVersion: 1,
        workspaces: { "": workspace },
        packages: { [name]: [`${name}@${next}`, "", {}, `sha512-${Buffer.alloc(64).toString("base64")}`] },
      }),
    );
  }
}

export function nativeUpdateFixture(roots: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-update-")));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "upstream");
  const old = overlayFixture(source, remote, "reviewed-overlay", "19.0.0");
  fixtureGit(remote, "branch", "-M", "main");
  fixtureGit(remote, "tag", "v19.0.0", old.commit);
  for (const [directory, section, name] of NATIVE_PINS) {
    mkdirSync(join(source, directory), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(source, directory, "package.json"),
      JSON.stringify({
        name: `fixture-${directory.replaceAll("/", "-")}`,
        private: true,
        scripts: { test: "echo trusted-source-test" },
        [section]: { [name]: "19.0.0" },
      }),
    );
  }
  fixtureDependencyFiles(source, source, "19.0.0", "19.0.0");
  fixtureGit(source, "init", "--quiet");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "--quiet", "-m", "Pinned native source and package fixture");
  const sourceCommit = fixtureGit(source, "rev-parse", "HEAD");
  const advance = (version = "19.0.1", conflict = false) => {
    fixtureGit(remote, "reset", "--hard", old.commit);
    writeFileSync(join(remote, "packages/coding-agent/package.json"), JSON.stringify({ version }));
    writeFileSync(
      join(remote, conflict ? "index.ts" : "new-upstream.ts"),
      conflict ? 'export const selected = "incoming";\n' : "export const incoming = true;\n",
    );
    fixtureGit(remote, "add", ".");
    fixtureGit(remote, "commit", "--quiet", "-m", `Release ${version}`);
    fixtureGit(remote, "tag", `v${version}`);
    return fixtureGit(remote, "rev-parse", "HEAD");
  };
  return { root, source, remote, old, sourceCommit, advance, output: join(root, "candidate") };
}

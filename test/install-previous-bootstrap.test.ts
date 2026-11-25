import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { oldPrimary, OLD_CONFIG } from "./install-previous-setup.ts";
import { archive } from "./release-consumer-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang tool stubs.
const posix = test.skipIf(process.platform === "win32");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const repo = resolve(import.meta.dir, "..");
const bridge = join(repo, "scripts/previous-install");
const files = [
  "cli.ts",
  "config.ts",
  "homes.ts",
  "leftovers.ts",
  "paths.ts",
  "retire.ts",
  "running.ts",
  "settings.ts",
  "supervisor.ts",
  "target.ts",
];

/** A release whose source carries the real bridge and a release CLI that records its arguments. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-bootstrap-previous-")));
  roots.push(root);
  const bin = join(root, "bin"),
    home = join(root, "home"),
    dist = join(root, "dist");
  for (const dir of [bin, home, dist]) mkdirSync(dir);
  const executable = (name: string, text: string) => writeFileSync(join(bin, name), text, { mode: 0o755 });
  executable(
    "bun",
    `#!/bin/bash
{ printf '%s\\n' 'Object.defineProperty(process, "platform", {value: "linux"}); Object.defineProperty(process, "arch", {value: "x64"}); Object.defineProperty(Bun, "version", {value: "1.4.4"});'; cat; } | "${process.execPath}" "$@"
`,
  );
  executable("git", "#!/bin/sh\nexit 0\n");
  const cli = `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.BOOTSTRAP_RESULT, JSON.stringify(process.argv.slice(2)));\n`;
  const entries = [
    {
      path: "release-headless.json",
      bytes: JSON.stringify({ version: 1, profiles: [{ platform: "linux", arch: "x64", runtime: "headless" }] }),
    },
    { path: "src/release/cli.ts", bytes: cli },
    // The bridge's own imports resolve to this checkout's modules; only the release CLI is a stand-in.
    ...[
      "skills/cataly-mode/scripts/src/config.ts",
      "src/release/process-cwd.ts",
      "src/release/process-files.ts",
      "src/update/proc.ts",
      "src/update/ulw-fixture.ts",
    ].map((path) => ({ path, bytes: `export * from ${JSON.stringify(join(repo, path))};\n` })),
    ...files.map((name) => ({
      path: `scripts/previous-install/${name}`,
      bytes: readFileSync(join(bridge, name), "utf8"),
    })),
  ];
  const source = entries.map((entry) => ({
    path: entry.path,
    sha256: digest(entry.bytes),
    executable: false,
  }));
  const bytes = archive(entries.map((entry) => ({ name: `cataly-1.2.3/${entry.path}`, bytes: entry.bytes })));
  const name = "cataly-v1.2.3.tar.gz";
  const metadata = JSON.stringify({
    version: 2,
    product: "cataly",
    releaseVersion: "1.2.3",
    tag: "v1.2.3",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    prerelease: false,
    requirements: { omp: "19.0.1" },
    archive: { name, root: "cataly-1.2.3", sha256: digest(bytes), bytes: bytes.length },
    source: { version: 1, files: source, excluded: [], hash: digest(JSON.stringify({ files: source })) },
  });
  writeFileSync(join(dist, "release-manifest.json"), metadata);
  writeFileSync(join(dist, "SHA256SUMS"), `${digest(metadata)}  release-manifest.json\n${digest(bytes)}  ${name}\n`);
  writeFileSync(join(dist, name), bytes);
  chmodSync(join(dist, "release-manifest.json"), 0o600);
  const result = join(root, "result.json");
  const run = () =>
    Bun.spawnSync(["bash", join(import.meta.dir, "../install.sh"), "--from", dist], {
      env: { PATH: `${bin}:${process.env["PATH"]}`, HOME: home, BOOTSTRAP_RESULT: result },
      stdout: "pipe",
      stderr: "pipe",
    });
  return { root, home, result, run };
}

posix("the release bootstrap imports an earlier home before installing and retires it afterwards", () => {
  const f = fixture();
  const old = oldPrimary(f.home);
  const r = f.run();
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const target = join(f.home, ".cataly");
  const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
  expect(config.defaultModel).toBe(OLD_CONFIG.defaultModel);
  expect(config).not.toHaveProperty("runtime");
  expect(readFileSync(join(target, "discord-token"), "utf8")).toBe("old-discord\n");
  // The release CLI ran with the converted configuration in place, and the earlier home is gone.
  const argv: string[] = JSON.parse(readFileSync(f.result, "utf8"));
  expect(argv.slice(0, 3)).toEqual(["install", "--from", argv[2]!]);
  expect(argv[2]!.endsWith("/dist")).toBe(true);
  expect(argv.slice(3)).toEqual(["--version", "v1.2.3", "--home", target]);
  expect(existsSync(old)).toBe(false);
  expect(r.stderr.toString()).toContain(`Removed the previous installation ${old}`);
});

import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archive } from "./release-consumer-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const linux = { platform: "linux", arch: "x64", runtime: "headless" } as const;
export const darwin = { platform: "darwin", arch: "arm64", runtime: "headless" } as const;

export function fixture(profile: typeof linux | typeof darwin) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-bootstrap-")));
  roots.push(root);
  const bin = join(root, "bin"),
    home = join(root, "home"),
    dist = join(root, "dist");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(dist);
  const executable = (name: string, text: string) => writeFileSync(join(bin, name), text, { mode: 0o755 });
  executable(
    "bun",
    `#!/bin/bash
{ printf '%s\\n' 'Object.defineProperty(process, "platform", {value: "${profile.platform}"}); Object.defineProperty(process, "arch", {value: "${profile.arch}"}); Object.defineProperty(Bun, "version", {value: "1.4.4"});'; cat; } | "${process.execPath}" "$@"
`,
  );
  executable("git", "#!/bin/sh\nexit 0\n");
  // The verified release CLI install.sh forwards to; it records its strict arguments and environment.
  const cli = `import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
const args = parseArgs({ args: process.argv.slice(3), strict: true, options: { from: { type: "string" }, version: { type: "string" }, home: { type: "string" } } });
writeFileSync(process.env.BOOTSTRAP_RESULT, JSON.stringify({ command: process.argv[2], home: args.values.home,
  env: { home: process.env.CATALY_HOME, config: process.env.CATALY_CONFIG, state: process.env.CATALY_STATE_DIR ?? null,
    runtime: process.env.CATALY_RUNTIME ?? null, cmd: process.env.CATALY_CMD ?? null, agent: process.env.CATALY_AGENT_CMD ?? null,
    argv: process.env.CATALY_AGENT_ARGV ?? null, startup: process.env.CATALY_MANAGED_STARTUP ?? null } }));
`;
  const base = {
    version: 2,
    product: "cataly",
    releaseVersion: "1.2.3",
    tag: "v1.2.3",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    prerelease: false,
  };
  /** `headless` undefined omits the bound profile file, which this installer refuses. */
  const assets = (headless?: unknown, omp = "19.0.1") => {
    const native = headless === undefined ? undefined : JSON.stringify(headless);
    const files = [
      ...(native === undefined ? [] : [{ path: "release-headless.json", sha256: digest(native), executable: false }]),
      { path: "src/release/cli.ts", sha256: digest(cli), executable: false },
    ];
    const bytes = archive([
      ...(native === undefined ? [] : [{ name: "cataly-1.2.3/release-headless.json", bytes: native }]),
      { name: "cataly-1.2.3/src/release/cli.ts", bytes: cli },
    ]);
    const name = "cataly-v1.2.3.tar.gz";
    const metadata = JSON.stringify({
      ...base,
      requirements: { omp },
      archive: { name, root: "cataly-1.2.3", sha256: digest(bytes), bytes: bytes.length },
      source: { version: 1, files, excluded: [], hash: digest(JSON.stringify({ files })) },
    });
    writeFileSync(join(dist, "release-manifest.json"), metadata);
    writeFileSync(join(dist, "SHA256SUMS"), `${digest(metadata)}  release-manifest.json\n${digest(bytes)}  ${name}\n`);
    writeFileSync(join(dist, name), bytes);
  };
  assets({ version: 1, profiles: [linux, darwin] });
  const result = join(root, "result.json");
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", join(import.meta.dir, "../install.sh"), "--from", dist, ...args], {
      env: { PATH: `${bin}:${process.env["PATH"]}`, HOME: home, USERPROFILE: home, BOOTSTRAP_RESULT: result, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
  const selected = () => JSON.parse(readFileSync(result, "utf8"));
  const expected = (home: string) => ({
    command: "install",
    home,
    env: {
      home,
      config: join(home, "config.json"),
      state: null,
      runtime: null,
      cmd: null,
      agent: null,
      argv: null,
      startup: null,
    },
  });
  return { root, home, dist, result, run, selected, assets, expected };
}

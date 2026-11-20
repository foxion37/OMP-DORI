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
export const linux = { platform: "linux", arch: "x64", runtime: "herdr" } as const;
export const darwin = { platform: "darwin", arch: "arm64", runtime: "hc" } as const;

export function fixture(profile: typeof linux | typeof darwin) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-bootstrap-")));
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
  executable("omp", "#!/bin/sh\necho 18.18.8\n");
  executable("git", "#!/bin/sh\nexit 0\n");
  executable("herdr", "#!/bin/sh\nexit 0\n");
  executable("hc", "#!/bin/sh\nexit 0\n");
  const cli = `import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
const args = parseArgs({ args: process.argv.slice(3), options: { from: { type: "string" }, version: { type: "string" }, home: { type: "string" }, runtime: { type: "string" } } });
writeFileSync(process.env.BOOTSTRAP_RESULT, JSON.stringify({ home: args.values.home, runtime: args.values.runtime,
  env: { home: process.env.DORI_HOME, config: process.env.DORI_CONFIG, state: process.env.DORI_STATE_DIR ?? null,
    runtime: process.env.DORI_RUNTIME ?? null, cmd: process.env.DORI_CMD ?? null, agent: process.env.DORI_AGENT_CMD ?? null,
    argv: process.env.DORI_AGENT_ARGV ?? null, ulw: process.env.DORI_OMP_ULW_PATH ?? null, startup: process.env.DORI_MANAGED_STARTUP ?? null } }));
`;
  const legacyCli = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
parseArgs({ args: process.argv.slice(3), strict: true, options: { from: { type: "string" }, version: { type: "string" } } });
const home = join(process.env.HOME, ".dori");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "legacy-installed"), "installed");
writeFileSync(process.env.BOOTSTRAP_RESULT, JSON.stringify({ home, runtime: "herdr",
  env: { home: process.env.DORI_HOME, config: process.env.DORI_CONFIG, state: process.env.DORI_STATE_DIR ?? null,
    runtime: process.env.DORI_RUNTIME ?? null, cmd: process.env.DORI_CMD ?? null, agent: process.env.DORI_AGENT_CMD ?? null,
    argv: process.env.DORI_AGENT_ARGV ?? null, ulw: process.env.DORI_OMP_ULW_PATH ?? null, startup: process.env.DORI_MANAGED_STARTUP ?? null } }));
`;
  const base = {
    version: 1,
    product: "omp-dori",
    releaseVersion: "1.2.3",
    tag: "v1.2.3",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    prerelease: false,
  };
  const assets = (capabilities?: unknown) => {
    const payload = capabilities === undefined ? undefined : JSON.stringify(capabilities);
    const consumer = payload === undefined ? legacyCli : cli;
    const files = [
      ...(payload === undefined
        ? []
        : [{ path: "release-capabilities.json", sha256: digest(payload), executable: false }]),
      { path: "src/release/cli.ts", sha256: digest(consumer), executable: false },
    ];
    const bytes = archive([
      ...(payload === undefined ? [] : [{ name: "omp-dori-1.2.3/release-capabilities.json", bytes: payload }]),
      { name: "omp-dori-1.2.3/src/release/cli.ts", bytes: consumer },
    ]);
    const name = "omp-dori-v1.2.3.tar.gz";
    const metadata = JSON.stringify({
      ...base,
      archive: { name, root: "omp-dori-1.2.3", sha256: digest(bytes), bytes: bytes.length },
      source: {
        version: 1,
        files,
        excluded: [],
        ulwPresent: false,
        hash: digest(JSON.stringify({ files, ulwPresent: false })),
      },
    });
    writeFileSync(join(dist, "release-manifest.json"), metadata);
    writeFileSync(join(dist, "SHA256SUMS"), `${digest(metadata)}  release-manifest.json\n${digest(bytes)}  ${name}\n`);
    writeFileSync(join(dist, name), bytes);
  };
  assets({ version: 1, profiles: [linux, darwin] });
  const result = join(root, "result.json");
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", join(import.meta.dir, "../install.sh"), "--from", dist, ...args], {
      env: { PATH: `${bin}:${process.env["PATH"]}`, HOME: home, BOOTSTRAP_RESULT: result, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
  const selected = () => JSON.parse(readFileSync(result, "utf8"));
  const expected = (home: string, runtime: string) => ({
    home,
    runtime,
    env: {
      home,
      config: join(home, "config.json"),
      state: null,
      runtime: null,
      cmd: null,
      agent: null,
      argv: null,
      ulw: null,
      startup: null,
    },
  });
  return { root, home, dist, result, run, selected, assets, expected };
}

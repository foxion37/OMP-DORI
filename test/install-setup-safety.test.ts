import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { script, setup } from "./install-setup.ts";

// POSIX-only: the source installer and its fixture use Bash and POSIX paths and permissions.
const posix = test.skipIf(process.platform === "win32");

const readback = (text: string): unknown => {
  const prefix = "SETUP_READBACK ";
  const receipt = text.split("\n").find((line) => line.startsWith(prefix));
  return JSON.parse(receipt?.slice(prefix.length) ?? "null");
};

posix.each(["primary", "side"] as const)("source %s setup creates a private home under umask 0002", (mode) => {
  const s = setup();
  const result = Bun.spawnSync(["bash", "-c", 'umask 0002; exec "$1"', "setup-umask", script], {
    env: s.env({ CATALY_INSTALL_MODE: mode, CATALY_NO_PULL: "1" }),
    stdin: "ignore",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const base = join(s.home, mode === "primary" ? ".cataly" : ".omp-cataly");
  expect(statSync(base).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, "config.json")).mode & 0o777).toBe(0o600);
  expect(s.install({ CATALY_INSTALL_MODE: mode, CATALY_NO_PULL: "1" }).code).toBe(0);
});

posix("source backup path creates a private home before preparation", () => {
  const s = setup();
  const extra: Record<string, string> = { CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" };
  const bin = join(s.home, "global-bin");
  mkdirSync(bin);
  symlinkSync(join(s.upstream, s.cli), join(bin, "cataly"));
  const result = Bun.spawnSync(["bash", "-c", 'umask 0002; exec "$1"', "setup-umask", script], {
    env: s.env(extra),
    stdin: "ignore",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const base = join(s.home, ".cataly");
  expect(statSync(base).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, "config.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(base, "backups"))).toHaveLength(1);
  expect(s.install(extra).code).toBe(0);
});

posix.each(["directory", "file"] as const)(
  "unsafe existing %s permissions are held with a repair instruction",
  (kind) => {
    const s = setup();
    const base = join(s.home, ".cataly");
    mkdirSync(base, { mode: 0o700 });
    const path = join(base, "config.json");
    writeFileSync(path, '{"owner":"retained"}\n', { mode: 0o600 });
    const target = kind === "directory" ? base : path;
    chmodSync(target, kind === "directory" ? 0o775 : 0o664);
    const before = statSync(target);
    const result = s.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Group/world-writable");
    expect(result.err).toContain("chmod go-w");
    expect(result.err).toContain(target);
    expect(statSync(target).mode).toBe(before.mode);
    expect(readFileSync(path, "utf8")).toBe('{"owner":"retained"}\n');
  },
);

posix("a source directory alias cannot retarget a captured configuration receipt", () => {
  const s = setup();
  const original = join(s.home, "original");
  const replacement = join(s.home, "replacement");
  const alias = join(s.home, "selected-alias");
  for (const base of [original, replacement]) {
    mkdirSync(base, { mode: 0o700 });
    writeFileSync(join(base, "config.json"), JSON.stringify({ owner: base }), { mode: 0o600 });
  }
  symlinkSync(original, alias);
  const helper = join(dirname(script), "source-configuration.ts");
  const capture = Bun.spawnSync([process.execPath, helper, "capture", alias, s.src, "side"], {
    env: s.env({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
  });
  expect(capture.exitCode, capture.stderr.toString()).toBe(0);
  unlinkSync(alias);
  symlinkSync(replacement, alias);
  const publish = Bun.spawnSync([process.execPath, helper, "publish-json", alias, s.src, "side"], {
    env: s.env({ CATALY_SETUP_SNAPSHOT: capture.stdout.toString(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
  });
  expect(publish.exitCode).toBe(1);
  expect(publish.stderr.toString()).toContain("snapshot does not belong");
  for (const base of [original, replacement])
    expect(readFileSync(join(base, "config.json"), "utf8")).toBe(JSON.stringify({ owner: base }));
});

posix("source JSON with no managed change retains original non-UTF-8 bytes", () => {
  const s = setup();
  const base = join(s.home, ".cataly");
  mkdirSync(base, { mode: 0o700 });
  const path = join(base, "config.json");
  const bytes = Buffer.concat([
    Buffer.from('{"agentCommand":["owner"],"owner":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  writeFileSync(path, bytes, { mode: 0o600 });
  const inode = statSync(path).ino;
  const result = s.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" });
  expect(result.code, result.err).toBe(0);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).ino).toBe(inode);
});

posix.each(["config.json", "omp.yml"] as const)("source refuses a lossy UTF-8 rewrite of %s", (name) => {
  const s = setup();
  const base = join(s.home, ".omp-cataly");
  mkdirSync(base, { mode: 0o700 });
  const path = join(base, name);
  const bytes = Buffer.concat([
    Buffer.from(name === "config.json" ? '{"owner":"' : 'owner: "'),
    Buffer.from([0xff]),
    Buffer.from(name === "config.json" ? '"}\n' : '"\n'),
  ]);
  writeFileSync(path, bytes, { mode: 0o600 });
  const inode = statSync(path).ino;
  const result = s.install({ CATALY_INSTALL_MODE: "side", CATALY_NO_PULL: "1" });
  expect(result.code).toBe(1);
  expect(result.err).toContain("UTF-8");
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).ino).toBe(inode);
});

posix("source setup reports the selected checkout reader's effective config", () => {
  const s = setup();
  const selected = join(s.home, ".cataly/config.json");
  const fallback = "checkout-default-pane";
  const reader = join(s.src, "skills/cataly-mode/scripts/src/config.ts");
  const sharedReader = JSON.stringify(new URL("../skills/cataly-mode/scripts/src/config.ts", import.meta.url).href);
  // This revision has a different default, so the same environment setting is not an override.
  writeFileSync(
    reader,
    `export { ConfigError, configPath } from ${sharedReader};
import { loadConfig as read } from ${sharedReader};
export async function loadConfig(path, home, env) {
  const config = await read(path, home, env);
  return { ...config, leadPane: env.CATALY_LEAD_PANE ?? ${JSON.stringify(fallback)} };
}
`,
  );

  const result = s.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1", CATALY_LEAD_PANE: fallback });
  expect(result.code, result.err).toBe(0);
  expect(readback(result.out)).toMatchObject({
    path: selected,
    selectedConfig: selected,
    effective: "selected",
    overridden: [],
  });
});

posix("source setup does not report success when the selected checkout has no reader", () => {
  const s = setup();
  unlinkSync(join(s.src, "skills/cataly-mode/scripts/src/config.ts"));
  const result = s.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" });
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("reader is unavailable in the selected source checkout");
  expect(result.out).not.toContain("SETUP_READBACK");
  expect(result.out).not.toContain("Installed.");
});

posix("effective-reader validation errors do not print private configuration values", () => {
  const s = setup();
  const base = join(s.home, ".cataly");
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, "config.json"), '{"runtime":{"secret":"do-not-print-this"}}\n', { mode: 0o600 });
  const result = s.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1" });
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Invalid effective Cataly configuration");
  expect(result.out + result.err).not.toContain("do-not-print-this");
  expect(result.out).not.toContain("Installed.");
});

posix.each([
  ["CATALY_AGENT_ARGV", "configuration-reader-unavailable"],
  ["CATALY_RUNTIME", "invalid-effective-configuration"],
] as const)("a failed %s override read still reports saved bytes without exposing the override", (key, reason) => {
  const s = setup();
  const invalid = "private-invalid-override";
  const result = s.install({ CATALY_INSTALL_MODE: "primary", CATALY_NO_PULL: "1", [key]: invalid });
  expect(result.code).not.toBe(0);
  expect(readback(result.out)).toMatchObject({
    saved: true,
    effective: "unavailable",
    overridden: null,
    reason,
  });
  expect(result.out + result.err).not.toContain(invalid);
});

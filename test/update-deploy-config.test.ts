import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { capturePointer, restorePointer, switchPointer } from "../src/update/deployment-files.ts";
import { processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { terminateBoundProcess } from "../src/update/deployment-signal.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");
// POSIX-only: a hard link preserves the symlink inode itself, which Windows cannot create.
const it = test.skipIf(process.platform === "win32");

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cataly-deploy-config-"));
  directories.push(root);
  const config = parseDeploymentConfig(
    {
      releaseRoot: "managed",
      liveSource: "~/.cataly/src",
      home: "home",
      catalyHome: "~/.cataly",
      catalyConfig: "~/.cataly/config.json",
      stateDir: "~/.cataly/state",
      bun: process.execPath,
      omp: process.execPath,
      restartLock: "~/.cataly/restart.lock",
      launcherPath: "~/.cataly/fixed-restart-controller",
      healthTimeoutMs: 100,
      shims: [
        { path: "~/.cataly/update/local-source", source: "." },
        { path: "~/.cataly/update/controller", source: "." },
      ],
    },
    root,
  );
  mkdirSync(config.liveSource, { recursive: true });
  writeFileSync(join(config.liveSource, "consumer.txt"), "legacy");
  return { root, config };
}

test("deployment config is canonical and names only the headless harness's paths", () => {
  const { root, config } = fixture();
  expect(JSON.stringify(parseDeploymentConfig(config, root))).toBe(JSON.stringify(config));
  expect(Object.keys(config).sort()).toEqual(
    [
      "bun",
      "catalyConfig",
      "catalyHome",
      "healthTimeoutMs",
      "home",
      "launcherPath",
      "liveSource",
      "omp",
      "releaseRoot",
      "restartLock",
      "shims",
      "stateDir",
      "stopTimeoutMs",
    ].sort(),
  );
  expect(() => parseDeploymentConfig({ ...config, unknownSetting: true }, root)).toThrow("unknown setting");
});

it("release-root shims remain stable through source conversion and restore their exact previous links", () => {
  const { root, config } = fixture();
  expect(config.home).toBe(join(root, "home"));
  expect(config.liveSource).toBe(join(config.home, ".cataly", "src"));
  const release = join(root, "published-source");
  mkdirSync(release);
  writeFileSync(join(release, "consumer.txt"), "published");
  mkdirSync(dirname(config.shims[0]!.path), { recursive: true });
  for (const shim of config.shims) symlinkSync("../src", shim.path);
  const pointers = [
    capturePointer(config.liveSource, release, "root-shims"),
    ...config.shims.map((shim) => capturePointer(shim.path, join(config.liveSource, shim.source), "root-shims")),
  ];
  for (const pointer of pointers) switchPointer(pointer);
  for (const shim of config.shims) {
    expect(readlinkSync(shim.path)).toBe(config.liveSource);
    expect(readFileSync(join(shim.path, "consumer.txt"), "utf8")).toBe("published");
  }
  expect(parseDeploymentConfig(config, root)).toEqual(config);
  for (const pointer of [...pointers].reverse()) restorePointer(pointer);
  for (const [index, shim] of config.shims.entries()) {
    expect(readlinkSync(shim.path)).toBe("../src");
    expect(lstatSync(shim.path).ino).toBe(pointers[index + 1]!.original!.ino);
    expect(readFileSync(join(shim.path, "consumer.txt"), "utf8")).toBe("legacy");
  }
});

test("only an exact dot selects the release root; traversal, empty segments and opaque ref paths stay held", () => {
  const { root, config } = fixture();
  for (const source of ["", "..", "src/../index.ts", "src/./index.ts", "src//index.ts", "src/", "/extension", "ref"])
    expect(() =>
      parseDeploymentConfig({ ...config, shims: [{ path: config.shims[0]!.path, source }] }, root),
    ).toThrow();
  expect(parseDeploymentConfig(config, root).shims.every((shim) => shim.source === ".")).toBe(true);
});

posix(
  "an owned executable rename retains kernel identity and bound termination reaches only its original child",
  async () => {
    const root = realpathSync(fixture().root);
    const image = join(root, "sleep");
    copyFileSync(Bun.which("sleep")!, image);
    const child = Bun.spawn([image, "60"], { stdout: "ignore", stderr: "ignore" });
    try {
      const identity = processIdentity(child.pid)!;
      expect(identity).toBeDefined();
      expect(identity.executable).toBe(image);
      renameSync(image, join(root, "preserved-sleep"));
      expect(processIdentity(child.pid)?.executable).toBe(join(root, "preserved-sleep"));
      expect(sameProcess(identity)).toBe(true);
      const terminated = terminateBoundProcess(identity);
      expect(
        terminated,
        JSON.stringify({
          expected: identity,
          current: processIdentity(child.pid) ?? null,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        }),
      ).toBe(true);
      await child.exited;
      expect(processIdentity(child.pid)).toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  },
);

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NATIVE_BINARY_ENV } from "../src/native-binary.ts";
import { HeadlessRuntime } from "../src/runtime/headless.ts";

const posix = test.skipIf(process.platform === "win32");
const resolver = resolve(import.meta.dir, "../src/native-binary.ts");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const scratch = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cataly-native-binary-")));
  directories.push(directory);
  return directory;
};
const executable = (path: string, body = "exit 0"): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
};

/** The resolver as a fresh process sees it: only HOME, PATH and the given variables, code tree `root`. */
const resolveIn = (root: string, env: Record<string, string>): string => {
  const script = `import { nativeBinary } from ${JSON.stringify(resolver)};
console.log(nativeBinary(${JSON.stringify(root)}) ?? "none");`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

posix("a shell without CATALY_HOME finds the binary installed in the default ~/.cataly", () => {
  const home = scratch();
  const root = scratch();
  expect(resolveIn(root, { HOME: home })).toBe("none");
  const installed = executable(join(home, ".cataly", "bin", "cataly-native"));
  expect(resolveIn(root, { HOME: home })).toBe(installed);
  // `off` turns off Discord-native features only; the headless host still resolves.
  expect(resolveIn(root, { HOME: home, [NATIVE_BINARY_ENV]: "off" })).toBe(installed);
});

posix("the code tree's bundled, then deployment-built binary wins over the installed one", () => {
  const home = scratch();
  const root = scratch();
  const installed = executable(join(home, "custom", "bin", "cataly-native"));
  const env = { HOME: home, CATALY_HOME: join(home, "custom") };
  // A developer's own cargo build is never picked up silently, stale or not.
  executable(join(root, "target", "release", "cataly"));
  expect(resolveIn(root, env)).toBe(installed);
  const built = executable(join(root, "target", "managed", "release", "cataly"));
  expect(resolveIn(root, env)).toBe(built);
  const bundled = executable(join(root, "native-bin", `${process.platform}-${process.arch}`, "cataly"));
  expect(resolveIn(root, env)).toBe(bundled);
});

posix("a host binary that exits before proving startup is named in the launch error", async () => {
  const directory = scratch();
  const stale = executable(join(directory, "stale-cataly"), "exit 2");
  const env = { HOME: directory, PATH: "/usr/bin:/bin" };
  const rt = new HeadlessRuntime(join(directory, "state"), env);
  const ref = await rt.create({ name: "stale", role: "lane", cwd: directory, env });
  const previous = process.env[NATIVE_BINARY_ENV];
  process.env[NATIVE_BINARY_ENV] = stale;
  try {
    await expect(rt.startNative(ref, ["omp"], env)).rejects.toThrow(
      `headless lane host \`${stale} headless-host\` exited (2) before proving startup`,
    );
  } finally {
    if (previous === undefined) delete process.env[NATIVE_BINARY_ENV];
    else process.env[NATIVE_BINARY_ENV] = previous;
  }
});

import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { consumerConfigPlan, previewConsumerSetup } from "../src/release/setup.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { captureSetupFile } from "../src/setup-files.ts";
import { setupReadback } from "../src/setup-readback.ts";
import { digest } from "../src/update/source.ts";
import { fixture, posix } from "./release-consumer-setup.ts";
import { boundRelease, releaseDist } from "./release-native-recovery-setup.ts";

const { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } = fs;
const supported = ["linux/x64", "darwin/arm64"].includes(`${process.platform}/${process.arch}`);

posix.each([false, true])(
  "consumer preview predicts exact new configuration without preparing or activating it (side=%s)",
  async (side) => {
    const f = fixture(side);
    const release = f.release("preview");
    const before = captureSetupFile(f.paths.config);
    const preview = previewConsumerSetup(f.paths, release.bundle, before);
    expect(preview.action).toBe("create");
    expect(captureSetupFile(f.paths.config)).toEqual(before);
    expect(readdirSync(f.paths.releases)).toEqual([]);
    expect(readdirSync(f.paths.manifests)).toEqual([]);
    expect(loadInstalled(f.paths)).toBeUndefined();
    expect(existsSync(f.paths.live)).toBe(false);
    await installBundle(f.paths, release.bundle, undefined);
    expect(digest(readFileSync(f.paths.config))).toBe(preview.afterSha256);
  },
);

posix("consumer install preview uses the real CLI without creating its selected home", () => {
  const f = fixture();
  const release = { dist: releaseDist(join(f.root, "cli-preview"), boundRelease(f, "cli-preview").bundle) };
  const selected = join(f.paths.home, ".omp-cataly");
  const temporary = join(f.root, "preview-tmp");
  mkdirSync(temporary, { mode: 0o700 });
  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/release/cli.ts"),
      "install",
      "--preview",
      "--from",
      release.dist,
      "--home",
      selected,
    ],
    {
      cwd: f.root,
      env: {
        HOME: f.paths.home,
        TMPDIR: temporary,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        CATALY_HOME: selected,
        CATALY_CONFIG: join(selected, "config.json"),
      },
    },
  );
  expect(existsSync(selected)).toBe(false);
  expect(readdirSync(temporary)).toEqual([]);
  if (!supported) {
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unsupported release host/runtime");
    return;
  }
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    preview: true,
    configuration: { action: "create", path: join(selected, "config.json") },
  });
  expect(result.stdout.toString()).not.toContain('"installed"');
});

posix("consumer setup preserves existing bytes and reports effective overrides without exposing values", async () => {
  const f = fixture();
  const text =
    '{ "sessionRuntime":"headless", "stateDir":"/owner/custom-state", "defaultModel":"owner/private-model", "unknown":{"secret":"private-value"} }\n';
  writeFileSync(f.paths.config, text, { mode: 0o640 });
  const before = captureSetupFile(f.paths.config);
  const release = f.release("preserve");
  expect(previewConsumerSetup(f.paths, release.bundle, before)).toMatchObject({
    action: "preserve",
    beforeSha256: digest(text),
    afterSha256: digest(text),
  });
  await installBundle(f.paths, release.bundle, undefined);
  expect(captureSetupFile(f.paths.config)).toEqual(before);
  const readback = await setupReadback(before, "consumer-updater-reader", { path: f.paths.config, home: f.paths.home });
  expect(readback).toMatchObject({ saved: true, effective: "shadowed", overridden: ["stateDir"] });
  expect(JSON.stringify(readback)).not.toContain("private-value");
  expect(JSON.stringify(readback)).not.toContain("private-model");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
});

posix("consumer preview, install and rollback retain non-UTF-8 configuration bytes", async () => {
  const f = fixture();
  const bytes = Buffer.concat([
    Buffer.from('{"defaultModel":"owner/model","owner":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  writeFileSync(f.paths.config, bytes, { mode: 0o600 });
  const snapshot = captureSetupFile(f.paths.config);
  const first = f.release("byte-preserving-one");
  expect(previewConsumerSetup(f.paths, first.bundle, snapshot)).toMatchObject({
    action: "preserve",
    beforeSha256: digest(bytes),
    afterSha256: digest(bytes),
  });
  const one = await installBundle(f.paths, first.bundle, undefined);
  const two = await installBundle(f.paths, f.release("byte-preserving-two").bundle, one);
  await rollbackRelease(f.paths, two);
  expect(readFileSync(f.paths.config)).toEqual(bytes);
  expect(captureSetupFile(f.paths.config)).toEqual(snapshot);
});

posix("consumer preparation refuses an owner-created config instead of treating it as its original input", async () => {
  const f = fixture();
  const release = f.release("created-during-preparation");
  const installing = installBundle(f.paths, release.bundle, undefined);
  const text = '{"defaultModel":"owner/model","owner":"concurrent creator"}\n';
  writeFileSync(f.paths.config, text, { mode: 0o600 });
  await expect(installing).rejects.toThrow("Configuration changed during setup");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(loadInstalled(f.paths)).toBeUndefined();
});

posix("consumer activation rechecks configuration after the launch gate and source verification", async () => {
  const f = fixture();
  const before = await installBundle(f.paths, f.release("one").bundle, undefined);
  const pointer = readlinkSync(f.paths.live);
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  const payload = join(pointer, "payload.txt");
  const staged = join(f.paths.cataly, "owner-save.json");
  writeFileSync(staged, text, { mode: 0o600 });
  const gate = join(f.paths.root, "consumer-launch.lock");
  const read = spyOn(fs, "readFileSync").mockImplementation(
    new Proxy(readFileSync, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        if (args[0] === payload && existsSync(gate)) fs.renameSync(staged, f.paths.config);
        return result;
      },
    }),
  );
  try {
    await expect(installBundle(f.paths, f.release("two").bundle, before)).rejects.toThrow(
      "Configuration changed during setup",
    );
  } finally {
    read.mockRestore();
  }
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(loadInstalled(f.paths)).toEqual(before);
});

posix("rollback holds a config edit made while the retained release is verified", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const two = await installBundle(f.paths, f.release("two").bundle, one);
  const rolling = rollbackRelease(f.paths, two);
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  writeFileSync(f.paths.config, text);
  await expect(rolling).rejects.toThrow("Configuration changed during setup");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(loadInstalled(f.paths)).toEqual(two);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, two.current));
});

posix("a consumer plan cannot publish another home's snapshot", () => {
  const f = fixture();
  const foreign = join(f.paths.home, "foreign.json");
  writeFileSync(foreign, "{}\n", { mode: 0o600 });
  expect(() => consumerConfigPlan(f.paths, captureSetupFile(foreign), f.root)).toThrow("another installation");
  expect(readFileSync(foreign, "utf8")).toBe("{}\n");
});

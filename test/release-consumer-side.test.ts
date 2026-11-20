import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { saveJson } from "../src/release/files.ts";
import { nativeOmp } from "../src/release/provision.ts";
import { ompStateDir } from "../src/runtime/omp.ts";
import { fixture, posix } from "./release-consumer-setup.ts";

posix(
  "an isolated consumer leaves primary discovery untouched and its CLI ignores inherited primary selection",
  async () => {
    const f = fixture(true);
    const primary = join(f.paths.home, ".dori");
    mkdirSync(primary);
    writeFileSync(join(primary, "config.json"), "primary config\n");
    const first = await installBundle(f.paths, f.release("first\n").bundle, undefined);
    // The real installed CLI needs the actual shipped entry point, not the payload-only bundle fixture.
    const cli = resolve(import.meta.dir, "../skills/dori-mode/scripts/src/cli.ts");
    const wrapper = readFileSync(join(f.paths.dori, "bin/dori"), "utf8");
    const run = Bun.spawnSync(
      [
        "bash",
        "-c",
        wrapper.replace(join(f.paths.live, "skills/dori-mode/scripts/src/cli.ts"), cli),
        "--",
        "update",
        "status",
      ],
      {
        env: {
          HOME: f.paths.home,
          PATH: process.env["PATH"],
          DORI_HOME: primary,
          DORI_CONFIG: join(primary, "config.json"),
          DORI_STATE_DIR: join(primary, "state"),
          DORI_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
      },
    );
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString()).installed.tag).toBe(first.current.tag);
    expect(readFileSync(join(primary, "config.json"), "utf8")).toBe("primary config\n");
    expect(existsSync(join(f.paths.home, ".agents"))).toBe(false);
    expect(existsSync(join(f.paths.home, ".omp"))).toBe(false);
  },
);

posix(
  "modified isolated wrappers hold an update and rollback without changing active source, config or owner bytes",
  async () => {
    const f = fixture(true);
    const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
    const two = await installBundle(f.paths, f.release("second\n").bundle, one);
    const pointer = readlinkSync(f.paths.live);
    const config = readFileSync(f.paths.config);
    const command = join(f.paths.dori, "bin/dori");
    writeFileSync(command, "owner wrapper\n");
    await expect(installBundle(f.paths, f.release("third\n").bundle, two)).rejects.toThrow(
      "Consumer reference changed",
    );
    await expect(rollbackRelease(f.paths, two)).rejects.toThrow("Consumer reference changed");
    expect(readlinkSync(f.paths.live)).toBe(pointer);
    expect(readFileSync(f.paths.config)).toEqual(config);
    expect(readFileSync(command, "utf8")).toBe("owner wrapper\n");
  },
);

posix("a side OMP launch bypasses foreign Dori wrappers and clears inherited harness and state selection", async () => {
  const f = fixture(true);
  const foreign = join(f.paths.home, "foreign");
  const native = join(f.paths.home, "native");
  mkdirSync(join(foreign, "bin"), { recursive: true });
  mkdirSync(native);
  writeFileSync(join(foreign, ".omp-dori"), "side\n");
  writeFileSync(join(foreign, "bin/omp"), "#!/bin/sh\necho wrong-home\n", { mode: 0o755 });
  writeFileSync(
    join(native, "omp"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({
    home: process.env.DORI_HOME, config: process.env.DORI_CONFIG, command: process.env.DORI_CMD,
    state: process.env.DORI_STATE_DIR, runtime: process.env.DORI_RUNTIME,
    argv: process.env.DORI_AGENT_ARGV, ulw: process.env.DORI_OMP_ULW_PATH, startup: process.env.DORI_MANAGED_STARTUP,
    hcSession: process.env.HC_SESSION, terminal: process.env.HC_TERMINAL_ID, socket: process.env.HC_SOCKET,
    herdrSession: process.env.DORI_HERDR_SESSION, pane: process.env.HERDR_PANE_ID
  }));\n`,
    { mode: 0o755 },
  );
  const previous = process.env["PATH"];
  process.env["PATH"] = `${foreign}/bin:${native}:${previous ?? ""}`;
  try {
    await installBundle(f.paths, f.release("first\n").bundle, undefined);
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
  const result = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--version"], {
    env: {
      HOME: f.paths.home,
      PATH: previous,
      DORI_HOME: foreign,
      DORI_CMD: "primary-harness",
      DORI_STATE_DIR: "primary-state",
      DORI_RUNTIME: "herdr",
      DORI_AGENT_ARGV: '["/foreign/omp"]',
      DORI_OMP_ULW_PATH: "/foreign/ulw/index.ts",
      DORI_MANAGED_STARTUP: "1",
      HC_SESSION: "primary-hc",
      HC_TERMINAL_ID: "primary-terminal",
      HC_SOCKET: "primary-socket",
      DORI_HERDR_SESSION: "primary-herdr",
      HERDR_PANE_ID: "primary-pane",
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString(), result.stderr.toString()).toStartWith("{");
  const observed = JSON.parse(result.stdout.toString());
  expect(observed).toMatchObject({
    home: f.paths.dori,
    config: f.paths.config,
    command: `'${join(f.paths.dori, "bin/dori-harness")}'`,
  });
  expect(observed.hcSession).not.toBe("primary-hc");
  expect(observed.herdrSession).not.toBe("primary-herdr");
  expect(observed.state).toBeUndefined();
  expect(observed.runtime).toBeUndefined();
  expect(observed.argv).toBeUndefined();
  expect(observed.ulw).toBeUndefined();
  expect(observed.startup).toBeUndefined();
  expect(observed.terminal).toBeUndefined();
  expect(observed.socket).toBeUndefined();
  expect(observed.pane).toBeUndefined();
  const own = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--version"], {
    env: {
      HOME: f.paths.home,
      PATH: previous,
      HC_SESSION: observed.hcSession,
      HC_TERMINAL_ID: "own-terminal",
      HC_SOCKET: "own-socket",
      DORI_HERDR_SESSION: observed.herdrSession,
      HERDR_PANE_ID: "own-pane",
    },
  });
  expect(own.exitCode).toBe(0);
  expect(JSON.parse(own.stdout.toString())).toMatchObject({
    terminal: "own-terminal",
    pane: "own-pane",
    socket: "own-socket",
  });
  writeFileSync(f.paths.config, "{}\n");
  expect(ompStateDir({ DORI_HOME: f.paths.dori, DORI_CONFIG: f.paths.config })).toBe(join(f.paths.dori, "state"));
});

posix(
  "an isolated OMP launch keeps OMP self-update off, since its wrapper is the first omp on the consumer PATH",
  async () => {
    const f = fixture(true);
    const native = join(f.paths.home, "native");
    mkdirSync(native);
    writeFileSync(
      join(native, "omp"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }));\n`,
      { mode: 0o755 },
    );
    const previous = process.env["PATH"];
    process.env["PATH"] = `${native}:${previous ?? ""}`;
    try {
      await installBundle(f.paths, f.release("first\n").bundle, undefined);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
    const result = Bun.spawnSync([join(f.paths.dori, "bin/omp"), "--version"], {
      env: { HOME: f.paths.home, PATH: previous },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const { argv, path } = JSON.parse(result.stdout.toString()) as { argv: string[]; path: string };
    expect(path.split(":")[0]).toBe(join(f.paths.dori, "bin"));
    const overlays = argv.flatMap((arg, index) => (argv[index - 1] === "--config" ? [arg] : []));
    expect(overlays).toContain(join(f.paths.dori, "omp.yml"));
    const merged = Object.assign({}, ...overlays.map((file) => Bun.YAML.parse(readFileSync(file, "utf8")) as object));
    expect(merged).toMatchObject({ update: { auto: false } });
  },
);

posix.each([false, true])("a side home is not a source marker (linked=%s)", (linked) => {
  const f = fixture();
  const native = join(f.paths.home, "bin");
  mkdirSync(native);
  const command = join(native, "omp");
  writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const marker = join(f.paths.home, ".omp-dori");
  const profile = join(f.paths.home, "side-profile");
  if (linked) {
    mkdirSync(profile);
    symlinkSync(profile, marker);
  } else mkdirSync(marker);
  const previous = process.env["PATH"];
  process.env["PATH"] = `${native}:${previous ?? ""}`;
  try {
    expect(nativeOmp()).toBe(command);
    if (linked) unlinkSync(marker);
    else renameSync(marker, profile);
    const target = linked ? join(f.paths.home, "source-marker") : marker;
    writeFileSync(target, "side\n");
    if (linked) symlinkSync(target, marker);
    expect(nativeOmp()).not.toBe(command);
    if (linked) {
      unlinkSync(target);
      expect(nativeOmp()).not.toBe(command);
    }
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
});

posix("an interrupted initial reference transaction resumes without taking over changed files", async () => {
  const f = fixture(true);
  const bundle = f.release("first\n").bundle;
  const before = await installBundle(f.paths, bundle, undefined);
  const receipt = join(f.paths.root, "consumer-references.json");
  const recorded = JSON.parse(readFileSync(receipt, "utf8"));
  const references = Object.fromEntries(
    Object.keys(recorded).map((path) => [
      path,
      {
        bytes: readFileSync(join(f.paths.dori, path), "utf8"),
        executable: path.startsWith("bin/"),
      },
    ]),
  );
  unlinkSync(receipt);
  for (const path of Object.keys(references).filter((path) => path !== "bin/dori"))
    unlinkSync(join(f.paths.dori, path));
  saveJson(join(f.paths.root, "consumer-references-pending.json"), { before: {}, references });
  const after = await installBundle(f.paths, bundle, before);
  expect(after).toEqual(before);
  expect(existsSync(join(f.paths.root, "consumer-references-pending.json"))).toBe(false);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(recorded);
});

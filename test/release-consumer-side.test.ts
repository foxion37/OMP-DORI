import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { saveJson } from "../src/release/files.ts";
import { fixture, posix } from "./release-consumer-setup.ts";

posix(
  "an isolated consumer leaves primary discovery untouched and its CLI ignores inherited primary selection",
  async () => {
    const f = fixture(true);
    const primary = join(f.paths.home, ".cataly");
    mkdirSync(primary);
    writeFileSync(join(primary, "config.json"), "primary config\n");
    const first = await installBundle(f.paths, f.release("first\n").bundle, undefined);
    // The real installed CLI needs the actual shipped entry point, not the payload-only bundle fixture.
    const cli = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");
    const wrapper = readFileSync(join(f.paths.cataly, "bin/cataly"), "utf8");
    const run = Bun.spawnSync(
      [
        "bash",
        "-c",
        wrapper.replaceAll(join(f.paths.live, "skills/cataly-mode/scripts/src/cli.ts"), cli),
        "--",
        "update",
        "status",
      ],
      {
        env: {
          HOME: f.paths.home,
          PATH: process.env["PATH"],
          CATALY_HOME: primary,
          CATALY_CONFIG: join(primary, "config.json"),
          CATALY_STATE_DIR: join(primary, "state"),
          CATALY_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
      },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
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
    const command = join(f.paths.cataly, "bin/cataly");
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

posix("an isolated OMP wrapper keeps OMP self-update off, since it is the first omp on the consumer PATH", async () => {
  const f = fixture(true);
  // The release's own launcher, which the wrapper execs as OMP, reports the argv and PATH it received.
  const launcher = `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }));\n`;
  await installBundle(f.paths, f.release("first\n", launcher).bundle, undefined);
  const result = Bun.spawnSync([join(f.paths.cataly, "bin/omp"), "--version"], {
    env: { HOME: f.paths.home, PATH: process.env["PATH"] },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const { argv, path } = JSON.parse(result.stdout.toString()) as { argv: string[]; path: string };
  expect(path.split(":")[0]).toBe(join(f.paths.cataly, "bin"));
  expect(argv.at(-1)).toBe("--version");
  const overlays = argv.flatMap((arg, index) => (argv[index - 1] === "--config" ? [arg] : []));
  expect(overlays).toContain(join(f.paths.cataly, "omp.yml"));
  const merged = Object.assign({}, ...overlays.map((file) => Bun.YAML.parse(readFileSync(file, "utf8")) as object));
  expect(merged).toMatchObject({ update: { auto: false } });
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
        bytes: readFileSync(join(f.paths.cataly, path), "utf8"),
        executable: path.startsWith("bin/"),
      },
    ]),
  );
  unlinkSync(receipt);
  for (const path of Object.keys(references).filter((path) => path !== "bin/cataly"))
    unlinkSync(join(f.paths.cataly, path));
  saveJson(join(f.paths.root, "consumer-references-pending.json"), { before: {}, references });
  const after = await installBundle(f.paths, bundle, before);
  expect(after).toEqual(before);
  expect(existsSync(join(f.paths.root, "consumer-references-pending.json"))).toBe(false);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(recorded);
});

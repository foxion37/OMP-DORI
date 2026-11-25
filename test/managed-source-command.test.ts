import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { shq } from "../src/delivery.ts";
import { setup } from "./install-setup.ts";
import { executable, managedCommand, shell } from "./managed-command-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

const suffix = ["--cataly-role", "lane", "--model", "{model}", "{prompt}"];

posix("reinstall preserves a lexical side default and managed selection recognizes its directory alias", async () => {
  const s = setup();
  const physical = join(s.home, "physical side");
  const alias = join(s.home, "side alias 'quote'");
  mkdirSync(physical);
  symlinkSync(physical, alias);
  writeFileSync(join(physical, ".omp-cataly"), "side\n");
  const stored = `${JSON.stringify(
    {
      agentCommand: [join(alias, "bin/omp"), ...suffix],
      defaultModel: "owner/retained",
    },
    null,
    2,
  )}\n`;
  const path = join(alias, "config.json");
  writeFileSync(path, stored);
  const installed = s.install({ CATALY_INSTALL_MODE: "side", CATALY_NO_PULL: "1", OMP_CATALY_HOME: alias });
  expect(installed.code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(stored);
  const f = managedCommand();
  const loaded = await loadConfig(path, s.home);
  expect(loaded.agentCommand).toEqual([...f.argv, ...suffix]);
  expect(loaded.defaultModel).toBe("owner/retained");
  expect(readFileSync(path, "utf8")).toBe(stored);
});

test.each([".omp-cataly", "releases/consumer-owner.json"])(
  "%s ownership recognizes only the configuration's lexical and canonical defaults even when omp is absent",
  async (marker) => {
    const f = managedCommand();
    const physical = join(f.root, "physical installation");
    const alias = join(f.root, "configuration alias");
    const unrelatedAlias = join(f.root, "external alias");
    mkdirSync(dirname(join(physical, marker)), { recursive: true });
    writeFileSync(join(physical, marker), marker === ".omp-cataly" ? "side\n" : "{}\n");
    symlinkSync(physical, alias);
    symlinkSync(physical, unrelatedAlias);
    const path = join(alias, "config.json");
    for (const root of [alias, physical]) {
      const command = join(root, "bin/omp");
      expect(existsSync(command)).toBe(false);
      writeFileSync(path, JSON.stringify({ agentCommand: [command, ...suffix] }));
      expect((await loadConfig(path, f.config.home)).agentCommand).toEqual([...f.argv, ...suffix]);
    }
    const external = [join(unrelatedAlias, "bin/omp"), ...suffix];
    writeFileSync(path, JSON.stringify({ agentCommand: external }));
    expect((await loadConfig(path, f.config.home)).agentCommand).toEqual(external);
    const custom = join(f.root, "external command alias");
    symlinkSync(join(physical, "bin/omp"), custom);
    writeFileSync(path, JSON.stringify({ agentCommand: [custom, ...suffix] }));
    expect((await loadConfig(path, f.config.home)).agentCommand).toEqual([custom, ...suffix]);
  },
);

posix(
  "source env replaces inherited actor selection while its wrapper preserves extensions, side config and process scope",
  () => {
    const s = setup();
    const native = join(s.root, "bin/omp");
    executable(native);
    const base = join(s.home, "side space 'quote'; literal");
    const installed = s.install({ CATALY_INSTALL_MODE: "side", CATALY_NO_PULL: "1", OMP_CATALY_HOME: base });
    expect(installed.code).toBe(0);
    expect(existsSync(join(s.home, "extensions/omp-cataly"))).toBe(false);
    const f = managedCommand();
    const ordinary = join(s.root, "ordinary workspace");
    mkdirSync(ordinary);
    const configModule = new URL("../skills/cataly-mode/scripts/src/config.ts", import.meta.url).href;
    const harnessModule = new URL("../src/harness.ts", import.meta.url).href;
    const code = `
    import { fill, loadConfig } from ${JSON.stringify(configModule)};
    import { agentCommand, defaultDeps } from ${JSON.stringify(harnessModule)};
    const config = await loadConfig();
    const argv = fill(config.agentCommand, {model: "fixture/model", prompt: "literal prompt"});
    const lane = Bun.spawnSync(argv);
    const cataly = Bun.spawnSync(["/bin/sh", "-c", agentCommand(defaultDeps(), "cataly") + " probe"]);
    console.log(JSON.stringify({
      argv,
      lane: { code: lane.exitCode, argv: lane.stdout.toString().split("\\0").slice(0, -1) },
      cataly: { code: cataly.exitCode, argv: cataly.stdout.toString().split("\\0").slice(0, -1) }
    }));
  `;
    const child = shell(`. ${shq(join(base, "env.sh"))}; exec ${shq(process.execPath)} -e ${shq(code)}`, ordinary, {
      ...f.env,
      HOME: s.home,
      CATALY_AGENT_CMD: "stale shell",
      CATALY_AGENT_EXECUTABLE: "retired",
    });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.argv).toEqual([
      join(base, "bin/omp"),
      "--cataly-role",
      "lane",
      "--model",
      "fixture/model",
      "literal prompt",
    ]);
    const wrapper = [native, "--no-extensions", "-e", join(s.src, "extension"), "--config", join(base, "omp.yml")];
    expect(result.lane).toEqual({ code: 0, argv: [...wrapper, ...result.argv.slice(1)] });
    expect(result.cataly).toEqual({ code: 0, argv: [...wrapper, "--cataly-role", "cataly", "probe"] });
  },
);

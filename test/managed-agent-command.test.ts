import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fill, loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { shq } from "../src/delivery.ts";
import { agentCommand, defaultDeps } from "../src/harness.ts";
import { consumerPaths, initialize } from "../src/release/files.ts";
import { setup } from "./install-setup.ts";
import { argvOutput, environment, executable, managedCommand, shell } from "./managed-command-setup.ts";

// POSIX-only: the fixture spawns /bin/sh wrappers and shebang executables through PATH.
const posix = test.skipIf(process.platform === "win32");

const model = "fixture/model";
const prompt = "literal prompt ; $(touch prompt-ran)";

const runConfig = async (path: string, home: string, root: string, env: Record<string, string>) => {
  const config = await loadConfig(path, home);
  const argv = fill(config.agentCommand, { model, prompt });
  const result = Bun.spawnSync(argv, { cwd: root, env });
  expect(result.exitCode).toBe(0);
  expect(argvOutput(result.stdout)).toEqual(argv);
  expect(existsSync(join(root, "prompt-ran"))).toBe(false);
  return config.agentCommand;
};

posix("managed argv overrides literal omp atomically before the shell command", async () => {
  const f = managedCommand();
  environment({ CATALY_AGENT_CMD: "false; touch override-ran" });
  const argv = await runConfig(f.config.catalyConfig, f.config.home, f.root, f.env);
  expect(argv).toEqual([...f.argv, "--cataly-role", "lane", "--model", "{model}", "{prompt}"]);
  expect(JSON.parse(f.env["CATALY_AGENT_ARGV"]!)).toEqual(f.argv);
  expect(f.env["CATALY_AGENT_CMD"]).toBeUndefined();
});

posix.each(["primary", "side"])("%s source defaults follow the complete managed command", async (mode) => {
  const s = setup();
  const side = join(s.home, "side install ; literal");
  const installed = s.install({ CATALY_INSTALL_MODE: mode, CATALY_NO_PULL: "1", OMP_CATALY_HOME: side });
  expect(installed.code).toBe(0);
  const base = mode === "side" ? side : join(s.home, ".cataly");
  const path = join(base, "config.json");
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.agentCommand[0]).toBe(join(base, "bin/omp"));
  expect(readFileSync(join(base, ".omp-cataly"), "utf8")).toBe(`${mode}\n`);
  const f = managedCommand();
  const selected = await runConfig(path, s.home, f.root, f.env);
  expect(selected).toEqual([...f.argv, ...stored.agentCommand.slice(1)]);
  if (mode === "side") {
    const result = shell(
      `. ${shq(join(base, "env.sh"))}; printf '%s\\0' "$CATALY_AGENT_ARGV" "\${CATALY_AGENT_CMD-unset}" "\${CATALY_AGENT_EXECUTABLE-unset}"`,
      f.root,
      {
        ...f.env,
        CATALY_AGENT_CMD: "stale",
        CATALY_AGENT_EXECUTABLE: "stale",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(argvOutput(result.stdout)).toEqual([JSON.stringify([join(base, "bin/omp")]), "unset", "unset"]);
  }
});

posix("a consumer-owned default outside consumer release directories follows the selected executable", async () => {
  const f = managedCommand();
  const paths = consumerPaths(f.config.home);
  initialize(paths);
  const installed = join(paths.cataly, "bin/omp");
  executable(installed);
  writeFileSync(paths.config, JSON.stringify({ agentCommand: [installed, "{prompt}"] }));
  expect(existsSync(join(paths.root, "consumer-owner.json"))).toBe(true);
  expect(await runConfig(paths.config, paths.home, f.root, f.env)).toEqual([...f.argv, "{prompt}"]);
});

posix("independent external omp commands and unmarked wrapper paths retain their actual argv", async () => {
  const f = managedCommand();
  const external = join(f.root, "owner tools/bin/omp");
  const unmarked = join(f.config.catalyHome, "bin/omp");
  for (const command of [external, unmarked]) {
    executable(command);
    const argv = [command, "--model", "{model}", "{prompt}"];
    writeFileSync(f.config.catalyConfig, JSON.stringify({ agentCommand: argv }));
    expect(await runConfig(f.config.catalyConfig, f.config.home, f.root, f.env)).toEqual(argv);
  }
  initialize(consumerPaths(f.config.home));
  writeFileSync(f.config.catalyConfig, JSON.stringify({ agentCommand: [external, "{prompt}"] }));
  expect(await runConfig(f.config.catalyConfig, f.config.home, f.root, f.env)).toEqual([external, "{prompt}"]);
});

posix.each([false, true])("a selected pathname present=%s never executes shell suffixes", (blocked) => {
  const f = managedCommand();
  const selected = join(f.root, "missing space ; touch missing-suffix; #", "omp");
  if (blocked) {
    mkdirSync(dirname(selected), { recursive: true });
    writeFileSync(selected, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  }
  environment({
    CATALY_AGENT_ARGV: JSON.stringify([selected, "--config", "missing config 'quote'"]),
    CATALY_AGENT_CMD: "touch fallback-ran",
  });
  for (const role of ["cataly", "lane"] as const) {
    const result = shell(`${agentCommand(defaultDeps(), role)} probe`, f.root, f.env);
    expect(result.exitCode).toBe(blocked ? 126 : 127);
    expect(result.stderr.toString()).toContain(selected);
  }
  expect(existsSync(join(f.root, "missing-suffix"))).toBe(false);
  expect(existsSync(join(f.root, "fallback-ran"))).toBe(false);
});

posix("shell command fragments and literal-default argv overrides retain their distinct contracts", async () => {
  const f = managedCommand();
  environment({ CATALY_AGENT_ARGV: undefined, CATALY_AGENT_CMD: f.omp });
  expect((await runConfig(f.config.catalyConfig, f.config.home, f.root, f.env))[0]).toBe(f.omp);
  const fragment = `env MODEL='user value' sh -c 'exec "$@"' user-command ${shq(f.omp)} --model 'user model'`;
  environment({ CATALY_AGENT_CMD: fragment });
  expect(defaultDeps().agentCmd).toBe(fragment);
  const result = shell(`${agentCommand(defaultDeps(), "lane")} ${shq(prompt)}`, f.root, f.env);
  expect(result.exitCode).toBe(0);
  expect(argvOutput(result.stdout)).toEqual([f.omp, "--model", "user model", prompt]);
  const collision = "printf 'shell-fragment'";
  executable(join(f.root, collision));
  const module = new URL("../src/harness.ts", import.meta.url).href;
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { defaultDeps } from ${JSON.stringify(module)};
       const command = defaultDeps().agentCmd;
       const result = Bun.spawnSync(["/bin/sh", "-c", command]);
       console.log(JSON.stringify({
         command, which: Bun.which(process.env.CATALY_AGENT_CMD), code: result.exitCode, out: result.stdout.toString()
       }));`,
    ],
    { cwd: f.root, env: { ...f.env, PATH: f.root, CATALY_AGENT_ARGV: undefined, CATALY_AGENT_CMD: collision } },
  );
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({
    command: collision,
    which: join(f.root, collision),
    code: 0,
    out: "shell-fragment",
  });
});

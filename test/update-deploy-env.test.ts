import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deploymentConfig } from "./update-deploy-setup.ts";

test("replacement children resolve private Bun and OMP before installed Dori while dropping ambient capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-deploy-env-"));
  try {
    const config = deploymentConfig(root);
    mkdirSync(config.stateDir, { recursive: true });
    for (const path of [config.bun, config.omp]) {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(process.execPath, path);
    }
    const installed = join(config.home, ".bun", "bin");
    const ambient = join(root, "ambient");
    mkdirSync(installed, { recursive: true });
    mkdirSync(ambient);
    symlinkSync(process.execPath, join(installed, "dori"));
    for (const path of [join(installed, "bun"), join(installed, "omp"), join(ambient, "dori")])
      writeFileSync(path, "#!/bin/sh\nexit 93\n", { mode: 0o755 });
    const input = join(config.stateDir, "consumer-input");
    writeFileSync(input, "8");
    const code = `console.log(JSON.stringify({
      result: Number(await Bun.file(${JSON.stringify(input)}).text()) * 7,
      home: process.env.HOME, pane: process.env.HERDR_PANE_ID, workspace: process.env.HERDR_WORKSPACE_ID,
      namespace: process.env.DORI_HERDR_SESSION,
      telemetry: process.env.DORI_TELEMETRY, tracking: process.env.DO_NOT_TRACK,
      leakedCapabilities: Object.keys(process.env).filter(name => /TOKEN|PASSWORD|COOKIE|SUDO|TEST_CONFIG/.test(name))
    }))`;
    const module = new URL("../src/update/deployment-process.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { actorEnv, command } from ${JSON.stringify(module)};
      const config = JSON.parse(process.env.TEST_CONFIG);
      const env = actorEnv(config);
      const observed = JSON.parse(await command(["dori", "-e", ${JSON.stringify(code)}], config.home, env, 10000));
      observed.tools = [];
      for (const [name, multiplier] of [["bun", 2], ["omp", 3]]) {
        const program = "console.log(Number(await Bun.file(" + ${JSON.stringify(JSON.stringify(input))} + ").text()) * " + multiplier + ")";
        observed.tools.push(Number(await command([name, "-e", program], config.home, env, 10000)));
      }
      console.log(JSON.stringify(observed));
    `,
      ],
      {
        cwd: root,
        env: {
          TEST_CONFIG: JSON.stringify(config),
          DORI_DISCORD_TOKEN: "fixture-credential",
          SUDO_PASSWORD: "fixture-sudo",
          DORI_TELEMETRY: "1",
          DO_NOT_TRACK: "0",
          PATH: ambient,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(error);
    const observed = JSON.parse(out) as Record<string, unknown>;
    expect(observed["result"]).toBe(56);
    expect(observed["tools"]).toEqual([16, 24]);
    expect(observed["home"]).toBe(config.home);
    expect(observed["pane"]).toBe(config.pane);
    expect(observed["workspace"]).toBe("w1");
    expect(observed["namespace"]).toBe("owned-namespace");
    expect(observed["telemetry"]).toBe("0");
    expect(observed["tracking"]).toBe("1");
    expect(observed["leakedCapabilities"]).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

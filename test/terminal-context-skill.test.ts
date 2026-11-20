import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { launchLane } from "../skills/dori-mode/scripts/src/launch.ts";
import { depsFor, fakeClock, newWorld } from "../skills/dori-mode/scripts/test/fakes.ts";
import { recordingOmp } from "./terminal-context-setup.ts";
import { expectContext, managedTerminal } from "./terminal-managed-setup.ts";

// POSIX-only: the transport fixture records through /bin/sh shebang programs and `env -0`.
const posix = test.skipIf(process.platform === "win32");

for (const runtime of ["herdr", "hc"] as const) {
  for (const external of [false, true]) {
    posix(`${runtime}: full skill launch crosses a conflicting daemon with external=${external}`, async () => {
      const f = managedTerminal(runtime);
      const custom = join(f.root, "external owner tools", "omp");
      const customUlw = join(f.root, "external owner tools", "ulw.ts");
      if (external) {
        mkdirSync(dirname(custom), { recursive: true });
        recordingOmp(custom);
        writeFileSync(
          f.config.doriConfig,
          JSON.stringify({
            runtime,
            stateDir: f.config.stateDir,
            defaultCwd: f.cwd,
            agentCommand: [custom, "--owner-option", "", "{prompt}"],
            ompUlwPath: customUlw,
          }),
        );
      }
      const config = await loadConfig(f.config.doriConfig, f.config.home);
      const base = depsFor(newWorld(), fakeClock(1_000_000), config.stateDir, {
        ...config,
        defaultCwd: f.cwd,
        laneWorkspace: "w1",
        goalMarker: "",
      });
      const deps = {
        ...base,
        run: async (argv: readonly string[]) => {
          const result = await f.daemon.exec(argv[0]!, argv.slice(1));
          return { code: result.code, out: result.stdout, err: result.stderr };
        },
      };
      try {
        const result = await launchLane(deps, {
          key: "skill-transport",
          title: "transport",
          brief: f.brief,
          done: "closed fixture/repo#7",
          cwd: f.cwd,
        });
        expect(result.startup).toStartWith("STARTUP_OK");
        expect(f.daemon.captures).toHaveLength(1);
        const child = expectContext(f.daemon.captures[0]!, {
          ...f.expected,
          DORI_OMP_ULW_PATH: external ? customUlw : f.expected.DORI_OMP_ULW_PATH,
        });
        if (external) {
          expect(child.argv.slice(0, 3)).toEqual([custom, "--owner-option", ""]);
          expect(child.argv).not.toContain("--config");
          expect(config.agentCommand[0]).toBe(custom);
          expect(config.ompUlwPath).toBe(customUlw);
        } else {
          expect(child.argv.slice(0, f.prefix.length)).toEqual(f.prefix);
          expect(child.argv.slice(f.prefix.length, f.prefix.length + 4)).toEqual([
            "--dori-role",
            "lane",
            "--model",
            config.defaultModel,
          ]);
        }
        expect(child.argv.at(-1)).toContain(f.brief);
        expect(child.argv.at(-1)).toContain("You are the skill-transport lane");
      } finally {
        await f.daemon.close();
      }
    });
  }
}

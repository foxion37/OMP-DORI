import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("dori harness forwards root flags, persists backlog changes and propagates root exit codes", async () => {
  const state = withState();
  try {
    const brief = join(state.dir, "brief.md");
    const config = join(state.dir, "config.json");
    writeFileSync(brief, "Keep the complete harness reachable.\n");
    writeFileSync(config, JSON.stringify({ stateDir: join(state.dir, "skill-state") }));
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        env: {
          HOME: state.dir,
          PATH: dirname(process.execPath),
          TMPDIR: state.dir,
          DORI_CONFIG: config,
          DORI_STATE_DIR: join(state.dir, "skill-state"),
          DORI_HOME: join(state.dir, "harness-state"),
          DORI_TELEMETRY: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, err, code };
    };
    const added = await invoke(
      "harness",
      "backlog",
      "add",
      "port-fixture",
      "--brief",
      brief,
      "--title",
      "A quoted title",
      "--priority",
      "2",
      "--decision",
      "Keep all commands?",
    );
    expect(added).toEqual({ code: 0, err: "", out: "ADDED port-fixture p2 (needs decision)\n" });
    expect((await invoke("harness", "backlog", "list")).out).toContain("DECIDE: Keep all commands?");
    expect((await invoke("harness", "backlog", "decide", "port-fixture", "--text", "Keep everything.")).code).toBe(0);
    expect((await invoke("harness", "backlog", "list")).out).toContain("A quoted title");
    const invalid = await invoke("harness", "backlog", "add", "Bad Id", "--brief", brief);
    expect(invalid.code).toBe(2);
    expect(invalid.err).not.toContain(" at ");
    expect((await invoke("harness", "missing-command")).code).toBe(64);
    const help = await invoke("harness", "--help");
    expect(help.code).toBe(0);
    for (const command of ["up", "inbox", "duty", "review", "merge", "loop", "backlog", "migrate"])
      expect(help.out).toContain(command);
    const skill = await invoke();
    expect(skill.code).toBe(0);
    expect(skill.out).toContain("claim-done");
    expect(skill.out).toContain("worklog");
  } finally {
    state.done();
  }
}, 120_000);

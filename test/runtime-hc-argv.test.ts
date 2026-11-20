import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { FakeHc, terminal } from "./fake-hc.ts";
import { T1 } from "./hc-rig.ts";

test.each([
  { foreground: { name: "bun", argv: ["bun", "/opt/omp", null] }, shell: false },
  { foreground: { name: "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" }, shell: false },
  { foreground: { name: "bash", argv: ["bash", "-c", "read answer", null] }, shell: true },
])("incomplete argv does not erase delivery hold evidence: %p", async ({ foreground, shell }) => {
  const stateDir = mkdtempSync(join(tmpdir(), "dori-hc-argv-"));
  try {
    const fake = new FakeHc({ t1: terminal({ status: shell ? null : { state: "idle" } }) });
    const rt = new HcRuntime(
      async (cmd, argv) => {
        const result = await fake.exec(cmd, argv);
        return argv[1] === "get"
          ? { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), foreground }) }
          : result;
      },
      { stateDir },
    );
    const result = shell ? await rt.typeIntoShell(T1, "do not deliver") : await rt.deliver(T1, "do not deliver");
    expect(fake.sent).toEqual([]);
    expect(result).toEqual(shell ? false : { kind: "not-ready", status: "unknown" });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

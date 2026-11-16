import { expect, test } from "bun:test";
import { hcDeploymentCli } from "../src/update/deployment-cli.ts";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { actorEnv } from "../src/update/deployment-process.ts";

const base = {
  releaseRoot: "managed",
  liveSource: "home/.dori/src",
  home: "home",
  doriHome: "home/.dori",
  doriConfig: "home/.dori/config.json",
  stateDir: "home/.dori/state",
  bun: "home/private-bun/bun",
  omp: "home/private-omp/omp",
  sessionId: "preserved-session",
  model: "openai-codex/gpt-6.1-sol",
  restartLock: "home/.dori/restart.lock",
  launcherPath: "home/.dori/bin/restart",
  healthTimeoutMs: 100,
};
const hcConfig = { ...base, runtime: "hc", hc: "home/private-cli/hc", hcSession: "default", pane: "t13j" };

test("an hc deployment names its binary, session and terminal, and its actor runs as that terminal", () => {
  // Given an hc deployment config.
  const config = parseDeploymentConfig(hcConfig, "/r");
  // Then it keeps the hc binary and session, and a resumed actor inherits the hc terminal identity, not a herdr pane.
  expect(config).toMatchObject({ runtime: "hc", hc: "/r/home/private-cli/hc", hcSession: "default", pane: "t13j" });
  expect(config.herdr).toBeUndefined();
  const env = actorEnv(config);
  expect(env).toMatchObject({ HC_TERMINAL_ID: "t13j", HC_SESSION: "default" });
  expect(env["HERDR_PANE_ID"]).toBeUndefined();
  expect(env["PATH"]?.split(":")).toContain("/r/home/private-cli");
  // And it reads back unchanged.
  expect(parseDeploymentConfig(config, "/r")).toEqual(config);
});

test("a deployment without a runtime is the herdr deployment it always was", () => {
  // Given a config written before runtimes existed.
  const config = parseDeploymentConfig({ ...base, herdr: "home/private-cli/herdr", pane: "w1:p1" }, "/r");
  // Then it is herdr, with the herdr pane identity.
  expect(Object.hasOwn(config, "runtime")).toBe(false);
  expect(parseDeploymentConfig({ ...config, runtime: "herdr" }, "/r")).toEqual(config);
  expect(actorEnv(config)).toMatchObject({ HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" });
});

test.each([
  ["a herdr pane id", { pane: "w1:p1" }, "pane"],
  ["a herdr binary", { herdr: "home/private-cli/herdr" }, "hc"],
  ["a herdr session", { herdrSession: "owned" }, "hc"],
  ["no hc binary", { hc: undefined }, "hc"],
  ["an unknown runtime", { runtime: "tmux" }, "runtime"],
])("an hc deployment with %s is refused", (_name, change, field) => {
  expect(() => parseDeploymentConfig({ ...hcConfig, ...change }, "/r")).toThrow(
    `invalid promotion.deployment.${field}`,
  );
});

test("hc's own failures are doubt: a gone terminal reads as a shell in front, and a start is one hc send", async () => {
  // Given an hc that knows no terminal t9 and records every call.
  const calls: string[][] = [];
  const cli = hcDeploymentCli(async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    if (argv[1] === "get")
      return { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "no t9" } }) };
    return { code: 0, stdout: "{}", stderr: "" };
  });
  // When its foreground is read and a command is started.
  const front = await cli.foreground("t9", "deployment held");
  await cli.start("t9", "cd '/w' && omp --resume=x");
  // Then the foreground is doubt, and the start typed exactly that command line through hc send.
  expect(front).toEqual({ shell: true });
  expect(calls).toEqual([
    ["hc", "--json", "get", "t9"],
    ["hc", "--json", "send", "t9", "--", "cd '/w' && omp --resume=x"],
  ]);
});

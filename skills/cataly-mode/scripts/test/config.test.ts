import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { ConfigError, fill, loadConfig } from "../src/config.ts";
import { footer } from "../src/launch-footer.ts";
import { sid, withState } from "./fakes.ts";

const state = withState();
afterEach(() => {
  delete process.env["CATALY_STATE_DIR"];
});

test("CATALY_STATE_DIR overrides state placement even when the config file is missing", async () => {
  process.env["CATALY_STATE_DIR"] = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
});

test("OMP paths expand while explicit commands, models and environment overrides keep their precedence", async () => {
  const path = join(state.dir, "omp-config.json");
  await Bun.write(
    path,
    JSON.stringify({
      stateDir: "~/configured-state",
      sessionsDir: "~/custom-sessions",
      leadPane: `headless:${sid(1)}`,
      defaultModel: "provider/custom-model",
      agentCommand: ["custom-agent", "--model", "{model}", "{prompt}"],
      guard: { panesMax: 7 },
      supervision: { defaults: { tokens: 1234 } },
    }),
  );
  const oldLead = process.env["CATALY_LEAD_PANE"];
  const oldConfig = process.env["CATALY_CONFIG"];
  try {
    process.env["CATALY_CONFIG"] = path;
    process.env["CATALY_STATE_DIR"] = state.dir;
    process.env["CATALY_LEAD_PANE"] = `headless:${sid(2)}`;
    const c = await loadConfig(undefined, "/home/ana");
    expect(c.stateDir).toBe(state.dir);
    expect(c.leadPane).toBe(`headless:${sid(2)}`);
    // The expansion joins with the platform's separator, as the OS would.
    expect(c.sessionsDir).toBe(join("/home/ana", "custom-sessions"));
    expect(c.defaultModel).toBe("provider/custom-model");
    expect(c.agentCommand).toEqual(["custom-agent", "--model", "{model}", "{prompt}"]);
    expect(c.guard).toMatchObject({ panesMax: 7 });
    expect(c.supervision.defaults?.tokens).toBe(1234);
  } finally {
    if (oldLead === undefined) delete process.env["CATALY_LEAD_PANE"];
    else process.env["CATALY_LEAD_PANE"] = oldLead;
    if (oldConfig === undefined) delete process.env["CATALY_CONFIG"];
    else process.env["CATALY_CONFIG"] = oldConfig;
  }
});

test("repoIdentities keys are matched as lowercase owner/repo, whatever case the file uses", async () => {
  const path = join(state.dir, "config.json");
  await Bun.write(
    path,
    JSON.stringify({ repoIdentities: { "Acme/App": { name: "Example Dev", email: "dev@example.com" } } }),
  );
  const c = await loadConfig(path, "/home/ana");
  expect(c.repoIdentities["acme/app"]).toEqual({ name: "Example Dev", email: "dev@example.com" });
});

test("malformed repoIdentities entries are dropped, so launch still writes its footer and verify-pr reports the repo as unconfigured", async () => {
  const path = join(state.dir, "config.json");
  const good = { name: "Example Dev", email: "dev@example.com" };
  await Bun.write(
    path,
    JSON.stringify({
      repoIdentities: {
        "acme/null": null,
        "acme/text": "dev@example.com",
        "acme/number": { name: 1, email: "dev@example.com" },
        "acme/blank": { name: "Example Dev", email: " " },
        "acme/app": good,
      },
    }),
  );
  const c = await loadConfig(path, "/home/ana");
  expect(c.repoIdentities).toEqual({ "acme/app": good });
  const lane = {
    key: "demo-lane",
    title: "demo",
    thread: "none",
    brief: "/b.md",
    done: "merged acme/app#1",
    openedAt: "2026-01-01T00:00:00Z",
  };
  expect(footer(lane, `headless:${sid(1)}`, c.repoIdentities)).toContain(
    "  - acme/app: git -c user.name='Example Dev'",
  );
  for (const value of [null, "acme", [good]]) {
    await Bun.write(path, JSON.stringify({ repoIdentities: value }));
    expect((await loadConfig(path, "/home/ana")).repoIdentities).toEqual({});
  }
});

test("a goalMarker that is not a string falls back to the default, so a typo never turns the goal check off", async () => {
  const path = join(state.dir, "config.json");
  for (const value of [null, false, 0, {}, ["Pursuing goal"]]) {
    await Bun.write(path, JSON.stringify({ goalMarker: value }));
    expect((await loadConfig(path, "/home/ana")).goalMarker).toBe("Pursuing goal");
  }
  // An empty string is the documented way to turn the check off, so it is kept.
  await Bun.write(path, JSON.stringify({ goalMarker: "" }));
  expect((await loadConfig(path, "/home/ana")).goalMarker).toBe("");
});

test("startupWaitSeconds is a nonnegative number of seconds; anything else falls back to 180", async () => {
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ startupWaitSeconds: 300 }));
  expect((await loadConfig(path, "/home/ana")).startupWaitSeconds).toBe(300);
  for (const value of [null, "300", -1, {}, [300]]) {
    await Bun.write(path, JSON.stringify({ startupWaitSeconds: value }));
    expect((await loadConfig(path, "/home/ana")).startupWaitSeconds).toBe(180);
  }
});

test("tern and headless runtime settings load", async () => {
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ runtime: "tern", sessionRuntime: "tern", laneRuntime: "terminal" }));
  const tern = await loadConfig(path, "/home/ana");
  expect([tern.runtime, tern.sessionRuntime, tern.laneRuntime]).toEqual(["tern", "tern", "terminal"]);
  await Bun.write(path, JSON.stringify({ sessionRuntime: "headless", laneRuntime: "headless" }));
  expect((await loadConfig(path, "/home/ana")).sessionRuntime).toBe("headless");
  await Bun.write(path, JSON.stringify({}));
  const empty = await loadConfig(path, "/home/ana");
  expect([empty.runtime, empty.sessionRuntime]).toEqual([undefined, undefined]);
  for (const value of [
    { runtime: "headless" },
    { runtime: "x" },
    { runtime: ["tern"] },
    { sessionRuntime: "x" },
    { sessionRuntime: "" },
    { sessionRuntime: 1 },
    { laneRuntime: "x" },
  ]) {
    await Bun.write(path, JSON.stringify(value));
    await expect(loadConfig(path, "/home/ana")).rejects.toBeInstanceOf(ConfigError);
  }
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], {
    thread: "chat:1/2",
    text: `it's "done"; rm -rf /`,
  });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

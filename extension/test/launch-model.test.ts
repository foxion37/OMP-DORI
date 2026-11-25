import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelReadback } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import { calls, load, useConfig, type FakeOptions } from "./fake-pi.ts";

const exact = { provider: "subscription", id: "exact" };

test("rpc-ui binds the native catalog proof to the launch and guards the first goal turn", async () => {
  const keys = ["CATALY_CONFIG", "CATALY_STATE_DIR", "CATALY_HEADLESS_ID"];
  const previous = keys.map((key) => process.env[key]);
  const stateDir = useConfig();
  const refId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "headless-launch";
  const settings: FakeOptions = {
    session: { id: sessionId, entries: [] },
    flags: { "cataly-role": "lane", "cataly-launch-model": "Subscription/Exact" },
    mode: "rpc",
    hasUI: true,
    model: { ...exact, id: "Exact" },
    catalog: [exact, { ...exact, id: "Exact" }],
    subscription: true,
  };
  process.env.CATALY_HEADLESS_ID = refId;
  let pi: Awaited<ReturnType<typeof load>> | undefined;
  try {
    pi = await load(settings);
    await pi.emit("session_start");
    expect(
      pi.session.entries.find((entry) => entry.customType === "omp-cataly:headless-launch-model")?.data,
    ).toMatchObject({
      refId,
      sessionId,
      proof: {
        requested: { provider: "Subscription", id: "Exact" },
        observed: { provider: "subscription", id: "Exact" },
        billing: "subscription",
        source: "native-extension",
        status: "matched",
      },
    });
    await pi.emit("goal_updated", { goal: { status: "active", objective: "test kickoff" } });
    await pi.emit("before_agent_start");
    await pi.emit("before_provider_request");
    settings.model = exact;
    await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
    settings.model = { ...exact, id: "Exact" };
    await pi.emit("before_provider_request");
    await pi.emit("agent_end");
    settings.model = exact;
    await pi.emit("before_agent_start");
    await pi.emit("before_provider_request");
  } finally {
    try {
      await pi?.emit("session_shutdown");
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(dirname(stateDir), { recursive: true, force: true });
    }
  }
});

for (const [name, options, status, thinking] of [
  ["exact subscribed model", { model: exact, subscription: true }, "matched"],
  ["literal colon-tagged id", { model: { ...exact, id: "exact:14b" }, selector: "subscription/exact:14b" }, "matched"],
  ["native case-insensitive exact identity", { model: exact, selector: "Subscription/EXACT" }, "matched"],
  [
    "different literal id with a case collision",
    { model: exact, selector: "subscription/Exact", catalog: [{ ...exact, id: "Exact" }, exact] },
    "mismatch",
  ],
  [
    "ambiguous case-insensitive id",
    { model: exact, selector: "subscription/EXACT", catalog: [{ ...exact, id: "Exact" }, exact] },
    "unknown",
  ],
  [
    "original literal id wins over a case collision",
    { model: { ...exact, id: "Exact" }, selector: "Subscription/Exact", catalog: [{ ...exact, id: "Exact" }, exact] },
    "matched",
  ],
  ["same id on another provider", { model: { ...exact, provider: "metered" }, catalog: [exact] }, "mismatch"],
  ["similar id on requested provider", { model: { ...exact, id: "exact-new" }, catalog: [exact] }, "mismatch"],
  ["unavailable subscription model", { model: exact, catalog: [] }, "unavailable"],
  [
    "thinking suffix at the same native level",
    { model: exact, selector: "subscription/exact:high", thinking: "high" },
    "matched",
    { requested: "high", observed: "high" },
  ],
  [
    "thinking suffix at another native level",
    { model: exact, selector: "subscription/exact:high", thinking: "low" },
    "mismatch",
    { requested: "high", observed: "low" },
  ],
  [
    "literal catalog id ending in a thinking level",
    { model: { ...exact, id: "exact:high" }, selector: "subscription/exact:high", thinking: "low" },
    "matched",
  ],
  ["colon suffix that is not a thinking level", { model: exact, selector: "subscription/exact:turbo" }, "unavailable"],
  ["unknown native selection", {}, "unknown"],
] as const) {
  test(`native launch guard: ${name}`, async () => {
    const keys = ["CATALY_CONFIG", "CATALY_STATE_DIR", "CATALY_HEADLESS_ID"];
    const previous = keys.map((key) => process.env[key]);
    const stateDir = useConfig();
    process.env.CATALY_HEADLESS_ID = "00000000-0000-4000-8000-000000000002";
    const selector = "selector" in options ? options.selector : "subscription/exact";
    const settings: FakeOptions = {
      session: { id: "model-session", entries: [] },
      flags: { "cataly-role": "lane", "cataly-launch-model": selector },
      mode: "rpc",
      hasUI: true,
      ...("model" in options ? { model: options.model } : {}),
      ...("subscription" in options ? { subscription: options.subscription } : {}),
      ...("catalog" in options ? { catalog: [...options.catalog] } : {}),
      ...("thinking" in options ? { thinking: options.thinking } : {}),
    };
    const pi = await load(settings);
    try {
      await pi.emit("session_start");
      const readback = (
        pi.session.entries.find((entry) => entry.customType === "omp-cataly:headless-launch-model")?.data as
          { proof?: ModelReadback } | undefined
      )?.proof;
      expect(readback).toMatchObject({
        requested: { provider: selector.split("/")[0], id: selector.split("/").slice(1).join("/") },
        status,
        source: "native-extension",
      });
      expect(readback?.thinking).toEqual(thinking);
      expect(Number.isFinite(Date.parse(readback?.checkedAt ?? ""))).toBe(true);
      expect(readback?.billing).toBe(
        settings.model ? (settings.subscription ? "subscription" : "non-subscription") : "unknown",
      );
      for (const event of ["before_agent_start", "before_provider_request"]) {
        if (status === "matched") await pi.emit(event);
        else {
          const aborts = calls.filter((call) => call === "abort").length;
          await expect(pi.emit(event)).rejects.toThrow("STARTUP_MODEL_HOLD");
          expect(calls.filter((call) => call === "abort")).toHaveLength(aborts + 1);
        }
      }
      if (status === "matched") {
        settings.model = { ...exact, provider: "metered" };
        await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
      }
      expect(pi.userMessages).toEqual([]);
    } finally {
      await pi.emit("session_shutdown");
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(dirname(stateDir), { recursive: true, force: true });
    }
  });
}

// Native host initialization on Windows can exceed the short subprocess deadline under CI load.
const fixtureTimeoutMs = process.platform === "win32" ? 60_000 : 25_000;
for (const boundary of ["session", "provider"] as const) {
  for (const availability of ["available", "unavailable", "thinking", "thinking-mismatch"] as const) {
    const requests = availability === "available" || availability === "thinking" ? "one request" : "zero requests";
    const title = `real native ${boundary} sends ${requests} for a launch model that is ${availability}`;
    test(
      title,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "cataly-native-launch-"));
        const config = join(home, "config.json");
        try {
          writeFileSync(config, JSON.stringify({ stateDir: join(home, "state") }));
          const fixture = join(import.meta.dir, "../../test/fixtures/omp-native-host/launch-model.ts");
          const child = Bun.spawn([process.execPath, "--no-env-file", fixture, boundary, availability], {
            cwd: home,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              HOME: home,
              USERPROFILE: home,
              TMPDIR: home,
              TEMP: home,
              TMP: home,
              NO_COLOR: "1",
              PI_CODING_AGENT_DIR: join(home, "agent"),
              CATALY_CONFIG: config,
              CATALY_TEST_OMP_ROOT: process.env.CATALY_TEST_OMP_ROOT,
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: fixtureTimeoutMs,
          });
          const [out, err, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code, [out, err, child.signalCode].filter(Boolean).join("\n")).toBe(0);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
      fixtureTimeoutMs + 5_000,
    );
  }
}

test("the launch lock follows its initial session, not ordinary sessions opened in the same process", async () => {
  const settings: FakeOptions = {
    session: { id: "launch-target", entries: [] },
    flags: { "cataly-role": "lane", "cataly-launch-model": "subscription/exact" },
    model: exact,
  };
  const pi = await load(settings);
  await pi.emit("session_start");
  const initial = pi.session;
  await pi.emit("before_provider_request");
  pi.session = { id: "ordinary", entries: [] };
  settings.model = { provider: "fixture", id: "other" };
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  await pi.emit("before_agent_start");
  await pi.emit("before_provider_request");
  pi.session = initial;
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
});

test("a new session carrying the lane role also carries its exact model lock", async () => {
  const settings: FakeOptions = {
    session: { id: "lane-before-new", entries: [] },
    flags: { "cataly-role": "lane", "cataly-launch-model": "subscription/exact" },
    model: exact,
  };
  const pi = await load(settings);
  await pi.emit("session_start");
  pi.session = { id: "lane-after-new", entries: [] };
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  await pi.emit("before_provider_request");
  settings.model = { provider: "fixture", id: "other" };
  await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
});

test("the initial launch cannot escape its model guard through a missing lane role", async () => {
  const pi = await load({
    session: { id: "wrong-role", entries: [] },
    flags: { "cataly-launch-model": "subscription/exact" },
    model: exact,
  });
  await pi.emit("session_start");
  await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
});

test("native children keep their own models instead of inheriting the root launch lock", async () => {
  const pi = await load({
    session: { id: "child", entries: [] },
    flags: { "cataly-role": "lane", "cataly-launch-model": "subscription/exact" },
    agent: { kind: "sub", id: "model-child" },
    model: { provider: "fixture", id: "other" },
  });
  await pi.emit("session_start");
  await pi.emit("before_provider_request");
});

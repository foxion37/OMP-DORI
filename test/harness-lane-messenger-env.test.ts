import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

// Inspect only the messenger assignments a native session starts with, never caller credentials.
const messengerEnv = (env: Readonly<Record<string, string | undefined>> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => /^CATALY_(DISCORD|TELEGRAM)_TOKEN$/.test(name)));
const emptyOverrides = { CATALY_DISCORD_TOKEN: "", CATALY_TELEGRAM_TOKEN: "" };

async function withFixtureConfig(root: string, run: () => Promise<unknown>): Promise<unknown> {
  const previous = process.env["CATALY_CONFIG"];
  process.env["CATALY_CONFIG"] = join(root, "config.json");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["CATALY_CONFIG"];
    else process.env["CATALY_CONFIG"] = previous;
  }
}

test("harness start gives a lane explicit empty Discord and Telegram overrides", async () => {
  const { w, d, brief } = setup();
  expect(
    await withFixtureConfig(d.store.root, () =>
      main(["start", "new-lane", "--brief", brief, "--workspace", "fixture"], d),
    ),
  ).toBe(0);
  const lane = w.panes.get(d.store.lane("new-lane")!.sessionRef.id)!;
  expect(lane.env?.["CATALY_LANE"]).toBe("new-lane");
  expect(messengerEnv(lane.env)).toEqual(emptyOverrides);
});

test("harness up clears messenger tokens for duty and the loops, not the lead", async () => {
  const w = new World();
  const d = w.deps();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await withFixtureConfig(d.store.root, () => up(d, d.store.root));
  } finally {
    log.mockRestore();
  }
  const roles = d.store.roles();
  const env = (role: "lead" | "duty" | "duty-loop" | "hourly-loop") => w.panes.get(roles[role]!.id)!.env;
  expect(messengerEnv(env("lead"))).toEqual({});
  for (const role of ["duty", "duty-loop", "hourly-loop"] as const)
    expect(messengerEnv(env(role))).toEqual(emptyOverrides);
});

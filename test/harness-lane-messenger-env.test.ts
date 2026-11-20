import { expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { migrateWorld } from "./migrate-setup.ts";

// Inspect only the messenger assignments sent to the terminal server, never caller credentials.
const messengerArgs = (command: string[]) => command.filter((arg) => /^DORI_(DISCORD|TELEGRAM)_TOKEN=/.test(arg));
const emptyOverrides = ["DORI_DISCORD_TOKEN=", "DORI_TELEGRAM_TOKEN="];

async function withFixtureConfig(root: string, run: () => Promise<number>): Promise<number> {
  const previous = process.env["DORI_CONFIG"];
  process.env["DORI_CONFIG"] = join(root, "config.json");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["DORI_CONFIG"];
    else process.env["DORI_CONFIG"] = previous;
  }
}

test("harness start sends explicit empty Discord and Telegram overrides to the terminal server", async () => {
  const { w, d, brief } = setup({ runtime: "hc" });
  expect(
    await withFixtureConfig(d.store.root, () =>
      main(["start", "new-lane", "--brief", brief, "--workspace", "fixture"], d),
    ),
  ).toBe(0);
  const run = w.hc.calls.find((args) => args[0] === "run" && args.includes("dori.lane=new-lane"))!;
  expect(run).toContain("DORI_LANE=new-lane");
  expect(messengerArgs(run)).toEqual(emptyOverrides);
});

test("harness migrate clears messenger tokens for the lane, not lead or duty", async () => {
  const { w, d } = migrateWorld();
  w.addPane("w1:p2", "idle");
  d.store.setRole("duty", href("w1:p2"));
  const target = d.runtimes.default;
  const start = target.start.bind(target);
  target.start = async (ref, command) => {
    await start(ref, command);
    w.hc.terminals.get(ref.id)!.status = { state: "idle", app: "omo" };
  };

  expect(
    await withFixtureConfig(d.store.root, () => main(["migrate", "--all", "--to", "hc", "--wait-minutes", "0"], d)),
  ).toBe(0);
  const runs = w.hc.calls.filter((args) => args[0] === "run");
  expect(runs).toHaveLength(3);
  const [lane, lead, duty] = runs;
  expect(lane!).toContain("dori.role=lane");
  expect(lane!).toContain("DORI_LANE=k");
  expect(messengerArgs(lane!)).toEqual(emptyOverrides);
  expect(lead!).toContain("dori.role=lead");
  expect(messengerArgs(lead!)).toEqual([]);
  expect(duty!).toContain("dori.role=duty");
  expect(messengerArgs(duty!)).toEqual([]);
  expect(d.store.lane("k")?.sessionRef.runtime).toBe("hc");
  expect(d.store.roles().lead?.runtime).toBe("hc");
  expect(d.store.roles().duty?.runtime).toBe("hc");
});

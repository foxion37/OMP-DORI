import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { adoptLane } from "../src/adopt.ts";
import { launchLane } from "../src/launch.ts";
import { queueFixture } from "./launch-queue-fixture.ts";

test("a concurrent adopt waits for launch ownership and cannot replace its pane or brief", async () => {
  const f = await queueFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const contended = Promise.withResolvers<void>();
  const deps = {
    ...f.deps,
    clock: {
      now: f.deps.clock.now,
      sleep: async (ms: number) => {
        if (ms === 50) contended.resolve();
        await f.deps.clock.sleep(ms);
      },
    },
    run: async (...args: Parameters<typeof f.deps.run>) => {
      const [argv] = args;
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        entered.resolve();
        await release.promise;
      }
      return f.deps.run(...args);
    },
  };
  const launched = launchLane(deps, f.input);
  try {
    await entered.promise;
    const adopted = adoptLane(deps, { ...f.input, title: "competing adopt", pane: "w1:p1" }).then(
      () => {
        contended.reject(new Error("adopt bypassed launch ownership"));
        return "unexpected adoption";
      },
      (error: unknown) => {
        contended.reject(new Error("adopt failed before waiting for ownership"));
        return String(error);
      },
    );
    try {
      await contended.promise;
      expect(await f.deps.registry.read(f.input.key)).toBeNull();
    } finally {
      release.resolve();
    }
    const result = await launched;
    expect(result.startup).toContain("STARTUP_OK");
    expect(await adopted).toContain("already registered");
    const stored = await f.deps.registry.read(f.input.key);
    expect(stored?.title).toBe(f.input.title);
    expect(stored?.pane).toBe(result.lane.pane);
    expect(f.creates()).toBe(1);
    expect(f.world.calls.filter((a) => a[0] === "herdr" && a[2] === "close")).toEqual([]);
    expect(readFileSync(f.input.brief, "utf8")).toContain("Implement the recorded request");
  } finally {
    release.resolve();
    await launched.catch(() => {});
    f.state.done();
  }
});

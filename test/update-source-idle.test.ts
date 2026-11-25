import { expect, test as bunTest } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../src/platform/index.ts";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { DeploymentHeld, sameProcess } from "../src/update/deployment-process.ts";
import { sourceIdleNow } from "../src/update/source-update-idle.ts";
import { idleFixture } from "./update-source-idle-setup.ts";

// A real headless lead needs process readers and a Unix socket.
const test = bunTest.skipIf(!platform.supportsProcessReaders || process.platform === "win32");

test("source idle uses live process-owned receipts without opening the private session", async () => {
  const f = await idleFixture();
  try {
    expect(await sourceIdleNow(f.config, f.runtime)).toMatchObject({ receivers: 1, runtime: f.runtime });
    expect((await sourceIdleNow(f.config, f.runtime)).quietMs).toBeGreaterThanOrEqual(1_800_000);
    await f.send("received");
    await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow("quiet period");
  } finally {
    await f.close();
  }
});

for (const event of ["unavailable", "stale", "future"] as const)
  test(`source idle holds on a ${event} actual receiver`, async () => {
    const f = await idleFixture();
    try {
      await f.send(event);
      await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow(DeploymentHeld);
    } finally {
      await f.close();
    }
  });

test("source idle requires a new quiet interval after receiver recovery", async () => {
  const f = await idleFixture();
  try {
    await f.send("unavailable");
    await f.send("healthy");
    await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow("quiet period");
    await f.send("received");
    await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow("quiet period");
  } finally {
    await f.close();
  }
});

for (const status of ["working", "paused", "done-claimed", "legacy"])
  test(`source idle counts ${status} lanes as open`, async () => {
    const f = await idleFixture();
    try {
      const lanes = join(f.config.deployment.stateDir, "lanes");
      mkdirSync(lanes, { recursive: true });
      writeFileSync(
        join(lanes, "open.json"),
        JSON.stringify({ key: "open", ...(status === "legacy" ? {} : { status }) }),
      );
      await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow("open lanes");
    } finally {
      await f.close();
    }
  });

test("source idle ignores closed history but holds unreadable lanes", async () => {
  const f = await idleFixture();
  try {
    const lanes = join(f.config.deployment.stateDir, "lanes");
    mkdirSync(lanes, { recursive: true });
    writeFileSync(join(lanes, "old.json"), JSON.stringify({ key: "old", status: "closed" }));
    expect((await sourceIdleNow(f.config, f.runtime)).receivers).toBe(1);
    writeFileSync(join(lanes, "broken.json"), "{");
    await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow("unreadable lane");
  } finally {
    await f.close();
  }
});

for (const change of ["approval", "working", "session"] as const)
  test(`source idle rechecks the lead's current headless admission: ${change}`, async () => {
    const f = await idleFixture();
    try {
      if (change === "approval") await f.lead.deliver("request approval");
      if (change === "working") await f.lead.deliver("background job");
      const expected = change === "session" ? { ...f.runtime, sessionFile: "/different-session" } : f.runtime;
      await expect(sourceIdleNow(f.config, expected)).rejects.toThrow("no longer idle");
    } finally {
      await f.close();
    }
  });

for (const corruption of ["missing", "owner", "malformed"])
  test(`source idle treats ${corruption} receiver evidence as held`, async () => {
    const f = await idleFixture();
    try {
      await f.send("freeze");
      if (corruption === "missing") unlinkSync(f.activity);
      else if (corruption === "malformed") writeFileSync(f.activity, "{");
      else {
        const record = JSON.parse(readFileSync(f.activity, "utf8"));
        record.process.startTicks += "0";
        saveDeploymentJson(f.activity, record);
      }
      await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow(DeploymentHeld);
    } finally {
      await f.close();
    }
  });

test("source idle rejects a dead receiver even while its lead and recent heartbeat remain", async () => {
  const f = await idleFixture();
  try {
    await f.send("stop-receiver");
    expect(sameProcess(f.runtime)).toBe(true);
    await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow(DeploymentHeld);
  } finally {
    await f.close();
  }
});

for (const corruption of ["missing", "malformed", "session"])
  test(`source idle holds on ${corruption} monitor evidence`, async () => {
    const f = await idleFixture();
    try {
      if (corruption === "missing") unlinkSync(f.desired);
      else if (corruption === "malformed") writeFileSync(f.desired, "{");
      else saveDeploymentJson(f.desired, { ...f.manifest, sessionId: "different-session" });
      await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow(DeploymentHeld);
    } finally {
      await f.close();
    }
  });

test("source idle requires the managed intake heartbeat to be one of its actual activity writers", async () => {
  const f = await idleFixture();
  try {
    saveDeploymentJson(f.desired, {
      ...f.manifest,
      intake: { ...f.manifest.intake, path: join(f.root, "unrelated-heartbeat") },
    });
    await expect(sourceIdleNow(f.config, f.runtime)).rejects.toThrow("configured activity receiver");
  } finally {
    await f.close();
  }
});

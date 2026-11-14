import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMonitorManifests } from "../skills/dori-mode/scripts/src/boot-monitors.ts";
import { fileTgInboundStore } from "../skills/dori-mode/scripts/src/messenger/telegram-inbound.ts";
import { Registry, type Lane } from "../skills/dori-mode/scripts/src/registry.ts";
import { Store } from "../src/store.ts";
import { applicationManifest } from "../src/update/app-state.ts";
import { restoreUpdate, snapshotUpdate } from "../src/update/recovery.ts";
import { fixture } from "./update-setup.ts";

describe("candidate application state recovery", () => {
  test("fresh restore preserves paused lanes, receipt verdicts, monitor specs and inbound cursor through real consumers", async () => {
    const f = fixture();
    const job = (await f.updater.once("stage")).job!;
    const application = join(f.config.root, "application");
    const skill = join(application, "skill");
    const registry = new Registry(skill);
    const lane: Lane = {
      key: "candidate-work",
      title: "Paused candidate work",
      thread: "none",
      brief: "candidate brief",
      done: "file result.txt",
      sessionRef: { runtime: "herdr", id: "w1:p1" },
      status: "paused",
      pausedFrom: "working",
      openedAt: new Date().toISOString(),
    };
    await registry.write(lane);
    const store = new Store(join(application, "harness"));
    const receipt = {
      pr: "example/project#1",
      sha: f.config.baseUpstream,
      verdict: "BLOCK" as const,
      model: "historical-review",
      at: 1,
      summary: "Existing blocked receipt",
    };
    store.saveReceipt(receipt);
    fileTgInboundStore(join(skill, "telegram-offset")).save(314);
    const monitors = {
      version: 1,
      sessionId: "candidate-session",
      monitors: [
        { name: "candidate-watch", argv: ["dori", "watch"], cwd: job.candidate, filter: "LANE_", suspended: true },
      ],
    };
    f.write(skill, "monitors/candidate-session.json", JSON.stringify(monitors));
    f.write(skill, "sessions/identity.json", '{"sessionId":"candidate-session","role":"lane"}');
    f.write(application, "auth.json", '{"token":"candidate-only-auth-must-not-be-copied"}');
    const before = applicationManifest(application);
    const snapshot = snapshotUpdate(f.updater.context, job.id, join(f.directory, "app-snapshot"), application);
    await registry.write({ ...lane, status: "closed" });
    fileTgInboundStore(join(skill, "telegram-offset")).save(999);
    const restored = restoreUpdate(f.updater.context, snapshot, join(f.directory, "app-restored"));
    const restoredApplication = join(restored, "app-state");
    const restoredSkill = join(restoredApplication, "skill");
    expect(applicationManifest(restoredApplication).hash).toBe(before.hash);
    expect((await new Registry(restoredSkill).read(lane.key))?.status).toBe("paused");
    expect((await new Registry(restoredSkill).read(lane.key))?.pausedFrom).toBe("working");
    expect((await registry.read(lane.key))?.status).toBe("closed");
    expect(new Store(join(restoredApplication, "harness")).receipt(receipt.pr, receipt.sha)).toEqual(receipt);
    expect(fileTgInboundStore(join(restoredSkill, "telegram-offset")).load()).toBe(314);
    expect(fileTgInboundStore(join(skill, "telegram-offset")).load()).toBe(999);
    const watched = readMonitorManifests(join(restoredSkill, "sessions"), [], join(restoredSkill, "monitors"));
    expect(watched.errors).toEqual([]);
    expect(watched.manifests[0]?.data).toEqual(monitors);
    expect(existsSync(join(restoredApplication, "auth.json"))).toBe(false);
    const recovery = JSON.parse(readFileSync(join(restored, "recovery.json"), "utf8"));
    expect(recovery.applicationStateHash).toBe(before.hash);
    expect(recovery.phase).toBe("interrupted");
    const unchangedApplication = applicationManifest(application).hash;
    expect(() =>
      snapshotUpdate(f.updater.context, job.id, join(f.directory, "source-as-state"), f.localSource),
    ).toThrow();
    expect(existsSync(join(f.directory, "source-as-state"))).toBe(false);
    expect(() =>
      snapshotUpdate(f.updater.context, job.id, join(f.directory, "candidate-as-state"), job.candidate),
    ).toThrow();
    expect(existsSync(join(f.directory, "candidate-as-state"))).toBe(false);
    expect(applicationManifest(application).hash).toBe(unchangedApplication);
  });
});

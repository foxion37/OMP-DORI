import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget } from "../src/target.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store-types.ts";
import { World } from "./fake.ts";

const UUID = "00000000-0000-4000-8000-000000000003";

const lane = (key: string, sessionRef: SessionRef, status: Lane["status"] = "working"): Lane => ({
  key,
  sessionRef,
  brief: "/b.md",
  cwd: "/w",
  status,
  createdAt: 0,
  lastActivityAt: 0,
  progressAt: 0,
  noticeId: `notice-${key}`,
  progressEpoch: 0,
  nudges: 0,
  log: [],
});

function setup() {
  const d = new World().deps();
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "tern:1", duty: "tern:2" }));
  d.store.saveLane(lane("7", { runtime: "tern", id: "5" }));
  d.store.saveLane(lane("t8", { runtime: "tern", id: "8" }, "done"));
  return d;
}

describe("resolveTarget: headless ref, role, open lane key, Tern ref", () => {
  test.each([
    [`headless:${UUID}`, { runtime: "headless", id: UUID }],
    ["tern:3", { runtime: "tern", id: "3" }],
    ["lead", { runtime: "tern", id: "1" }],
    ["duty", { runtime: "tern", id: "2" }],
    ["7", { runtime: "tern", id: "5" }],
  ] as const)("%s", (target, want) => {
    expect(resolveTarget(setup(), target)).toEqual(want);
  });

  test.each([
    ["t8", "unknown target t8"],
    ["nobody", "unknown target nobody"],
    ["tern:t7", "unknown target tern:t7"],
    ["headless:t7", "not a session ref"],
    ["hourly-loop", "no hourly-loop session registered"],
  ])("%s is refused: %s", (target, why) => {
    expect(() => resolveTarget(setup(), target)).toThrow(Refusal);
    expect(() => resolveTarget(setup(), target)).toThrow(why);
  });
});

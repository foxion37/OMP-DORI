import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../src/delivery.ts";
import { migrate } from "../src/migrate.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { writeJournal } from "../src/store-journal.ts";
import { terminal } from "./fake-hc.ts";
import { expectContext, managedTerminal } from "./terminal-managed-setup.ts";

for (const runtime of ["herdr", "hc"] as const) {
  test(`${runtime}: reopened migration journals preserve context for lanes, lead, duty and both controllers`, async () => {
    const f = managedTerminal(runtime);
    const deps = { ...f.deps, doriCmd: shq(f.omp) };
    const from: SessionRef = runtime === "hc" ? { runtime: "herdr", id: "wold:p1" } : { runtime: "hc", id: "told" };
    const options: MigrateOpts = {
      to: runtime,
      dryRun: false,
      waitMinutes: 0,
      resume: false,
      sleep: async (ms) => {
        f.world.clock += ms;
      },
      log: () => {},
    };
    try {
      for (const role of ["lead", "duty", "duty-loop", "hourly-loop"] as const) {
        deps.store.setRole(role, from);
        writeJournal(deps.store.root, {
          name: role,
          kind: "role",
          phase: "hold",
          from,
          to: runtime,
          at: 1,
          briefPath: f.brief,
        });
        expect(await migrate(deps, { role }, options)).toBe(0);
      }
      deps.store.saveLane({
        key: "migration-lane",
        sessionRef: from,
        paneId: from.id,
        tabId: "",
        brief: f.brief,
        cwd: f.cwd,
        status: "working",
        createdAt: 1,
        lastActivityAt: 1,
        nudges: 0,
        log: [],
      });
      writeJournal(deps.store.root, {
        name: "migration-lane",
        kind: "lane",
        phase: "hold",
        from,
        to: runtime,
        at: 1,
        briefPath: f.brief,
      });
      expect(await migrate(deps, { lane: "migration-lane" }, options)).toBe(0);
      expect(f.daemon.captures).toHaveLength(5);
      for (const [at, capture] of f.daemon.captures.entries()) {
        const child = expectContext(capture, f.expected);
        if (at < 2 || at === 4) expect(child.argv.slice(0, f.prefix.length)).toEqual(f.prefix);
        else expect(child.argv[0]).toBe(f.omp);
      }
    } finally {
      await f.daemon.close();
    }
  });

  test(`${runtime}: native --resume migration keeps the session argument and complete selected context`, async () => {
    const f = managedTerminal(runtime);
    const from: SessionRef = runtime === "hc" ? { runtime: "herdr", id: "wold:p1" } : { runtime: "hc", id: "told" };
    if (from.runtime === "herdr") f.world.addPane(from.id, "idle").screen = "old idle session";
    else f.world.hc.terminals.set(from.id, terminal());
    const sessionPath = join(f.root, "saved session 'literal'.jsonl");
    writeFileSync(sessionPath, "{}\n");
    f.deps.store.saveLane({
      key: "resume-lane",
      sessionRef: from,
      paneId: from.id,
      tabId: "",
      brief: f.brief,
      cwd: f.cwd,
      sessionPath,
      status: "working",
      createdAt: 1,
      lastActivityAt: 1,
      nudges: 0,
      log: [],
    });
    try {
      expect(
        await migrate(
          f.deps,
          { lane: "resume-lane" },
          {
            to: runtime,
            dryRun: false,
            waitMinutes: 0,
            resume: true,
            sleep: async (ms) => {
              f.world.clock += ms;
            },
            log: () => {},
          },
        ),
      ).toBe(0);
      expect(f.daemon.captures).toHaveLength(1);
      const child = expectContext(f.daemon.captures[0]!, f.expected);
      expect(child.argv).toEqual([...f.prefix, "--dori-role", "lane", `--resume=${sessionPath}`]);
    } finally {
      await f.daemon.close();
    }
  });
}

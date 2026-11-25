import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { makeCli } from "../src/cli-context.ts";
import { report } from "../src/cli-report.ts";
import { freshnessTick } from "../src/freshness.ts";
import { reportId } from "../src/reports.ts";
import { agentIn } from "./fake-tern-world.ts";
import { waitFixture } from "./wait-fixture.ts";

for (const [name, owner, postRaw] of [
  ["summary-only owner", "Owner-safe summary", false],
  ["default owner", "Owner-safe summary", undefined],
  ["owner-less raw", undefined, undefined],
  ["explicit raw owner-less", undefined, true],
] as const)
  test(`wait metadata owner projection: ${name}`, async () => {
    const f = await waitFixture();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      agentIn(f.world, f.lane.sessionRef!.id, { body: "Working (1m)" });
      await f.deps.registry.write({ ...f.lane, thread: "discord:123" });
      const internal = "private-operation-identity";
      await report(
        makeCli(
          "report",
          [],
          {
            positionals: [f.lane.key],
            values: {
              kind: "blocker",
              text: "Private implementation detail",
              for: internal,
              ...(owner ? { owner } : {}),
              json: true,
            },
          },
          f.deps.config,
          f.deps,
        ),
      );
      const entry = f.reports.read(f.lane.key)?.lastReport;
      expect(entry?.wait?.target).toEqual({ kind: "label", text: internal });
      expect(JSON.stringify(log.mock.calls)).toContain(internal);
      const bytes = readFileSync(f.reports.path(f.lane.key), "utf8");
      f.advance(30 * 60_000);
      const deps = {
        ...f.deps,
        config: {
          ...f.deps.config,
          nudgeAfterMin: 1000,
          freshness: { ...(postRaw === undefined ? {} : { postRaw }) },
          hooks: { threadReply: ["notify", "{text}"] },
        },
      };
      await freshnessTick(deps, f.state.dir);
      const posted = f.world.calls.find(([command]) => command === "notify")?.[1];
      expect(posted).toBeDefined();
      if (owner) {
        expect(posted).toContain(owner);
        expect(posted).not.toContain(internal);
        expect(posted).not.toContain("WAIT ");
        expect(posted).not.toContain("Private implementation detail");
      } else expect(posted).toContain(internal);
      expect(readFileSync(f.reports.path(f.lane.key), "utf8")).toBe(bytes);
      expect((await f.deps.registry.read(f.lane.key))?.lastPostedReportId).toBe(reportId(entry!));
    } finally {
      log.mockRestore();
      f.done();
    }
  });

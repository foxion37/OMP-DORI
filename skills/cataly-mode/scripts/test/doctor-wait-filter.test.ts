import { expect, test } from "bun:test";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { monitorPresets } from "../src/monitor-presets.ts";

test("an old freshness filter warns about the new wait-ended event", () => {
  const preset = monitorPresets.find((item) => item.name === "freshness")!;
  const old = preset.filter.replace("|WAIT-ENDED", "");
  const findings = monitorFilterFindings(
    [
      {
        path: "/fixture",
        data: {
          version: 1,
          sessionId: "owner",
          monitors: [
            {
              name: "freshness",
              argv: ["cataly", "freshness"],
              filter: old,
              cwd: "/work",
            },
          ],
        },
      },
    ],
    "owner",
  );
  expect(findings.some((finding) => finding.detail.includes("WAIT-ENDED"))).toBe(true);
});

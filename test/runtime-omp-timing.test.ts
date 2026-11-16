import { describe, expect, test } from "bun:test";
import { ompWorld } from "./omp-setup.ts";

const packageRoot = "/private/native/source/packages/coding-agent/";
const preload = `${packageRoot}scripts/omp.ts`;
// The pinned scripts/omp preserves these parent segments in its second preload.
const timer = `${packageRoot}scripts/../../utils/src/module-timer.ts`;
const cli = `${packageRoot}scripts/../src/cli.ts`;
const argv = ["bun", "--preload", preload, "--preload", timer, cli];
const entries = [packageRoot, "/private/home space ; literal/source/packages/coding-agent/"].flatMap((root) =>
  [`${root}src/cli.ts`, `${root}scripts/../src/cli.ts`].map(
    (entry) =>
      [
        entry,
        [
          "/private/bin/bun",
          "--preload",
          `${root}scripts/omp.ts`,
          "--preload",
          `${root}scripts/../../utils/src/module-timer.ts`,
          entry,
          "--dori-role",
          "lane",
          "message with spaces ; literal",
        ],
      ] as const,
  ),
);
const invalid = [
  ["foreign timing tree", ["bun", "--preload", preload, "--preload", `/other${timer}`, cli]],
  [
    "foreign spaced timing tree",
    [
      "bun",
      "--preload",
      "/private/home one/source/packages/coding-agent/scripts/omp.ts",
      "--preload",
      "/private/home two/source/packages/coding-agent/scripts/../../utils/src/module-timer.ts",
      "/private/home one/source/packages/coding-agent/scripts/../src/cli.ts",
    ],
  ],
  ["arbitrary timing preload", ["bun", "--preload", preload, "--preload", "/unrelated/preload.ts", cli]],
  ["timing filename suffix", ["bun", "--preload", preload, "--preload", `${timer}.other`, cli]],
  ["missing timing operand", ["bun", "--preload", preload, "--preload", cli]],
  ["extra preload before timing", ["bun", "--preload", preload, "--preload", "/extra.ts", "--preload", timer, cli]],
  ["extra preload after timing", ["bun", "--preload", preload, "--preload", timer, "--preload", "/extra.ts", cli]],
  ["duplicate timing preload", ["bun", "--preload", preload, "--preload", timer, "--preload", timer, cli]],
  ["reordered timing preload", ["bun", "--preload", timer, "--preload", preload, cli]],
  ["timing without OMP preload", ["bun", "--preload", timer, cli]],
  ["foreign CLI tree", ["bun", "--preload", preload, "--preload", timer, `/other${cli}`]],
  ["CLI filename suffix", ["bun", "--preload", preload, "--preload", timer, `${cli}.other`]],
  ["another interpreter", ["node", ...argv.slice(1)]],
  ["shell mentioning timing", ["/bin/bash", "-c", ...argv]],
] as const;

for (const kind of ["herdr", "hc"] as const) {
  describe(`${kind}: source timing process identity`, () => {
    test.each(entries)("timing foreground %s without a record stays unknown", async (_, command) => {
      const s = ompWorld(kind, false, false);
      s.pane.agent = "other";
      s.pane.foreground = [{ name: "bun", argv: [...command] }];
      s.w.hc.terminals.get("t1")!.status = { state: "idle", app: "other" };
      s.w.hc.terminals.get("t1")!.foreground = { name: "bun", argv: [...command], pid: 101 };
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message", { force: true })).kind).toBe("not-ready");
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test.each(entries)("attests timing entry %s and holds approvals", async (_, command) => {
      const s = ompWorld(kind);
      s.pane.agent = "other";
      s.pane.foreground = [{ name: "bun", argv: [...command] }];
      s.w.hc.terminals.get("t1")!.status = { state: "idle", app: "other" };
      s.w.hc.terminals.get("t1")!.foreground = { name: "bun", argv: [...command], pid: 101 };
      s.control.table = `100 1 /bin/bash\n101 100 ${command.join(" ")}\n`;
      expect(await s.rt.probe(s.ref)).toMatchObject({
        status: "idle",
        pid: 101,
        sessionId: s.record.sessionId,
        sessionFile: s.record.sessionFile,
      });
      s.record.approvalPending = true;
      s.save();
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "blocked",
      });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
      s.record.approvalPending = false;
      s.save();
      expect((await s.rt.deliver(s.ref, "message")).kind).toBe("delivered");
      if (kind === "herdr") expect(s.pane.received).toEqual(["message"]);
      else expect(s.w.hc.sent).toEqual([{ id: "t1", text: "message" }]);
    });

    test.each(invalid)("rejects %s in argv and writer command", async (_, command) => {
      const s = ompWorld(kind, false, false);
      s.pane.agent = "other";
      s.pane.foreground = [{ name: "bun", argv: [...command] }];
      s.w.hc.terminals.get("t1")!.status = { state: "idle", app: "other" };
      s.w.hc.terminals.get("t1")!.foreground = { name: "bun", argv: [...command], pid: 101 };
      expect((await s.rt.probe(s.ref)).status).toBe("idle");
      s.save();
      s.control.table = `100 1 /bin/bash\n101 100 ${command.join(" ")}\n`;
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "unknown",
      });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test.each([
      ["joined timing pair", ["bun", "--preload", preload, `--preload ${timer}`, cli]],
      ["joined preload operands", ["bun", "--preload", `${preload} --preload ${timer}`, cli]],
      ["whole command argument", ["bun", argv.slice(1).join(" ")]],
    ] as const)("keeps %s as one argv boundary", async (_, command) => {
      const s = ompWorld(kind, false, false);
      s.pane.agent = "other";
      s.pane.foreground = [{ name: "bun", argv: [...command] }];
      s.w.hc.terminals.get("t1")!.status = { state: "idle", app: "other" };
      s.w.hc.terminals.get("t1")!.foreground = { name: "bun", argv: [...command], pid: 101 };
      expect((await s.rt.probe(s.ref)).status).toBe("idle");
      expect(s.psCalls).toEqual([]);
    });

    test.each(["writer ancestry", "foreground ancestry", "process start", "session", "pid", "session start"])(
      "timing still holds a changed %s",
      async (changed) => {
        const s = ompWorld(kind);
        s.control.table = `100 1 /bin/bash\n101 100 ${argv.join(" ")}\n`;
        if (changed === "writer ancestry") s.control.table = `100 1 /bin/bash\n101 200 ${argv.join(" ")}\n`;
        if (changed === "foreground ancestry") {
          s.record.pid = 201;
          s.save();
          s.control.table = `100 1 /bin/bash\n201 100 ${argv.join(" ")}\n101 100 vim\n`;
        }
        if (changed === "process start") s.control.started = "2026-11-11T00:01:00Z";
        if (changed === "session" || changed === "pid" || changed === "session start") {
          s.control.onPs = (args) => {
            if (args[0] !== "-o") return;
            if (changed === "session") s.record.sessionId += "-switched";
            if (changed === "pid") s.record.pid += 1;
            if (changed === "session start") {
              s.record.startedAt = "2026-11-11T00:00:06Z";
              s.record.updatedAt = s.record.startedAt;
            }
            s.save();
          };
        }
        expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
          kind: "not-ready",
          status: "unknown",
        });
        expect(s.pane.received).toEqual([]);
        expect(s.w.hc.sent).toEqual([]);
      },
    );
  });
}

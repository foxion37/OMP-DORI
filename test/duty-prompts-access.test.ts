import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// POSIX-only: an unprivileged uid and mode bits make the directory unreadable.
const posix = test.skipIf(process.platform === "win32");

posix.each(["nudge.md", "nudge-waiting.md"])(
  "an inaccessible %s override fails before consuming a nudge; a missing file still uses the built-in",
  async (name) => {
    // /tmp stays traversable when a root runner drops privileges in the isolated child.
    const root = mkdtempSync("/tmp/dori-prompts-access-");
    try {
      chmodSync(root, 0o755);
      for (const dir of ["src", "prompts"]) {
        cpSync(join(import.meta.dir, "..", dir), join(root, dir), { recursive: true });
      }
      cpSync(join(import.meta.dir, "..", "package.json"), join(root, "package.json"));
      mkdirSync(join(root, "test"));
      for (const file of ["fake.ts", "fake-hc.ts", "harness-setup.ts"]) {
        cpSync(join(import.meta.dir, file), join(root, "test", file));
      }
      const work = join(root, "work");
      mkdirSync(work);
      chmodSync(work, 0o777);
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import { accessSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doneIds, readQueue } from ${JSON.stringify(join(root, "src", "inbox-files.ts"))};
import { report } from ${JSON.stringify(join(root, "src", "lanes.ts"))};
import { quietLane } from ${JSON.stringify(join(root, "test", "harness-setup.ts"))};

if (process.geteuid() === 0) {
  process.setgroups([]);
  process.setgid(65534);
  process.setuid(65534);
}
const name = ${JSON.stringify(name)};
const { d, lane, pane, at } = await quietLane();
if (name === "nudge-waiting.md") {
  await report(d, "talker", "WAITING: CI", { status: "waiting", waitingFor: "CI" });
}
pane.received.length = 0;
const dir = join(process.env["TMPDIR"], "own-prompts");
mkdirSync(dir);
const own = join(dir, name);
writeFileSync(own, "custom nudge {{key}}");
const existed = existsSync(own);
const inbox = d.store.inboxPath(lane.sessionRef);
const before = d.store.lane("talker");
process.env["DORI_PROMPTS_DIR"] = dir;
try {
  chmodSync(dir, 0o600);
  const hidden = !existsSync(own);
  let accessError;
  try {
    accessSync(own);
  } catch (e) {
    accessError = e.code;
  }
  const failedEvents = await at(10);
  const afterFailure = {
    lane: d.store.lane("talker"),
    queued: readQueue(inbox),
    done: [...doneIds(inbox)],
    received: [...pane.received],
  };
  chmodSync(dir, 0o700);
  rmSync(own);
  const missingEvents = await at(11);
  const repeatEvents = await at(12);
  console.log(JSON.stringify({
    uid: process.geteuid(), existed, hidden, accessError, before, failedEvents, afterFailure,
    missingEvents, repeatEvents,
    afterFallback: {
      nudges: d.store.lane("talker").nudges,
      queued: readQueue(inbox),
      done: [...doneIds(inbox)],
      received: pane.received,
    },
  }));
} finally {
  chmodSync(dir, 0o700);
}`,
        ],
        {
          cwd: root,
          env: { ...process.env, TMPDIR: work, DORI_PROMPTS_DIR: join(root, "prompts") },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const result = JSON.parse(stdout);
      expect(result.uid).not.toBe(0);
      expect(result.existed).toBe(true);
      expect(result.hidden).toBe(true);
      expect(result.accessError).toBe("EACCES");
      expect(result.failedEvents).toEqual([
        expect.objectContaining({ lane: "talker", action: "lane-failed", detail: expect.stringMatching(/EACCES/) }),
      ]);
      expect(result.afterFailure).toEqual({ lane: result.before, queued: [], done: [], received: [] });
      expect(result.missingEvents).toContainEqual({ lane: "talker", action: "nudge-1" });
      expect(result.repeatEvents).toEqual([]);
      expect(result.afterFallback.nudges).toBe(1);
      expect(result.afterFallback.queued).toEqual([]);
      expect(result.afterFallback.done).toHaveLength(1);
      expect(result.afterFallback.done[0]).toStartWith("nudge:talker:");
      expect(result.afterFallback.received).toHaveLength(1);
      expect(result.afterFallback.received[0]).toContain("[duty -> talker]");
      expect(result.afterFallback.received[0]).toContain(
        name === "nudge-waiting.md" ? "Waiting on CI since" : "No new evidence since",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

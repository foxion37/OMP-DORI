import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateBoard } from "../src/board.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { laneStatus } from "../src/status.ts";
import { renderBoard, renderStatus } from "../src/status-render.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

let state: { dir: string; done: () => void };
const now = Date.parse("2026-01-01T13:00:00.000Z");
// Board writes fsync their directory, which Bun on Windows rejects.
const posix = test.skipIf(process.platform === "win32");
const lane: Lane = {
  key: "status-demo",
  title: "demo",
  thread: "discord:40",
  pane: "w:p7",
  openedAt: "2026-01-01T12:00:00Z",
  brief: "/brief",
  done: "file /done",
};
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("an unbound lane never adopts the current occupant of a reused pane", async () => {
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" }];
  agentIn(world, "w:p7");
  laneState(state.dir, "w:p7", { agentStatus: "working" });
  const deps = depsFor(world, fakeClock(now), state.dir);
  await deps.registry.write(lane);
  expect((await laneStatus(deps)).lanes[0]?.runtime).toBeNull();
});

test("incomplete decision and monitor journals are unknown, not authoritative zero", async () => {
  const deps = depsFor(newWorld(), fakeClock(now), state.dir);
  await deps.registry.write(lane);
  writeFileSync(join(state.dir, "decisions.jsonl"), "{broken\n");
  mkdirSync(join(state.dir, "monitors"));
  writeFileSync(join(state.dir, "monitors", "broken.json"), "{broken");
  const snapshot = await laneStatus(deps);
  expect(snapshot.decisions).toBeNull();
  expect(snapshot.lanes[0]?.decisions).toBeNull();
  expect(snapshot.monitors.recorded).toBeNull();
  expect(renderBoard(snapshot, "/home/test", 1960)).not.toContain("0 decisions open");
});

test("board removes all local path forms but keeps web evidence links", async () => {
  const deps = depsFor(newWorld(), fakeClock(now), state.dir);
  await deps.registry.write(lane);
  new Reports(state.dir).report(
    lane.key,
    "milestone",
    String.raw`/tmp/result.log /srv/private/project ~/private/report.md C:\private\report.md Log:/srv/private/project [/tmp/result.log] \\server\share\secret.txt https://example.test/report`,
    now,
  );
  const body = renderBoard(await laneStatus(deps), "/home/test", 1960);
  for (const path of ["/tmp/", "/srv/", "~/", "C:\\", "private", "server", "secret.txt"])
    expect(body).not.toContain(path);
  expect(body).toContain("https://example.test/report");
});

const renderLinkBoard = async (platform: "discord" | "telegram", clock = fakeClock(now)): Promise<string> => {
  const deps = depsFor(newWorld(), clock, state.dir);
  await deps.registry.write(lane);
  new Reports(state.dir).report(
    lane.key,
    "milestone",
    "https://bad%host/INVALID_PRIVATE 'https://O'MALLEY_USER:PRIVATE_PASS@example.test:8443/build/42?X-Amz-Signature=PRIVATE'SIGNATURE#PRIVATE_FRAGMENT' /srv/LOCAL_PRIVATE proof 'https://example.test/public'. ['https://example.test/bracketed'] {'https://example.test/braced'} https://example.test/team's-report",
    now,
  );
  return renderBoard(await laneStatus(deps), "/home/test", platform === "discord" ? 1960 : 4056);
};

const expectPublicLinks = (text: string): void => {
  expect(text).toContain("https://example.test:8443/build/42 ");
  expect(text).toContain("https://example.test/public ");
  expect(text).toContain("https://example.test/bracketed ");
  expect(text).toContain("https://example.test/braced ");
  expect(text).toContain("https://example.test/team's-report");
  expect(text).not.toContain("MALLEY_USER");
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain("X-Amz-Signature");
};

test.each(["discord", "telegram"] as const)("board rendering removes private URL data for %s", async (platform) => {
  expectPublicLinks(await renderLinkBoard(platform));
});

posix.each(["discord", "telegram"] as const)("board delivery removes private URL data for %s", async (platform) => {
  const clock = fakeClock(now);
  const requests: unknown[] = [];
  const result = await updateBoard({
    stateDir: state.dir,
    target: { platform, to: "40" },
    clock,
    token: "synthetic",
    body: await renderLinkBoard(platform, clock),
    http: async (request) => {
      requests.push(JSON.parse(typeof request.body === "string" ? request.body : ""));
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(platform === "discord" ? { id: "50" } : { ok: true, result: { message_id: 50 } }),
      };
    },
  });
  expect(result).toEqual({ action: "posted", messageId: "50" });
  expect(requests).toHaveLength(1);
  expectPublicLinks(JSON.stringify(requests[0]));
});

test("explicit out-of-tree session monitor metadata is included like boot", async () => {
  const external = join(state.dir, "external");
  const monitors = join(external, "extensions", "terminal");
  mkdirSync(monitors, { recursive: true });
  writeFileSync(
    join(monitors, "x.json"),
    JSON.stringify({
      version: 1,
      sessionId: "outside",
      monitors: [{ monitorId: "mon_a", sessionId: "outside", persistent: true }],
    }),
  );
  const deps = { ...depsFor(newWorld(), fakeClock(now), state.dir), env: { PI_SESSION_DIR: external } };
  expect((await laneStatus(deps)).monitors.recorded).toBe(1);
});

test("invalid elapsed timestamps are explicit unknown rather than NaN", async () => {
  const deps = depsFor(newWorld(), fakeClock(now), state.dir);
  await deps.registry.write({ ...lane, openedAt: "broken" });
  expect(renderStatus(await laneStatus(deps))).not.toContain("NaN");
});

posix("a definite rejected create can be invoked again after permissions are corrected", async () => {
  for (const platform of ["discord", "telegram"] as const) {
    let calls = 0;
    const options = {
      stateDir: state.dir,
      target: { platform, to: "40" },
      clock: fakeClock(now),
      token: "synthetic",
      body: "board",
      http: async () => {
        calls++;
        if (calls === 1)
          return {
            status: platform === "discord" ? 403 : 200,
            headers: {},
            body: JSON.stringify({ ok: false, error_code: 403, description: "Forbidden" }),
          };
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(platform === "discord" ? { id: "50" } : { ok: true, result: { message_id: 50 } }),
        };
      },
    };
    await expect(updateBoard(options)).rejects.toThrow("Forbidden");
    expect(await updateBoard(options)).toEqual({ action: "posted", messageId: "50" });
    expect(calls).toBe(2);
  }
});

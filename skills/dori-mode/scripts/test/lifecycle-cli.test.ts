import { afterEach, beforeEach, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
let config: string;
beforeEach(async () => {
  f = await lifecycleFixture();
  config = join(f.state.dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ stateDir: f.state.dir, runtime: "herdr", defaultCwd: f.deps.config.defaultCwd }),
  );
});
afterEach(() => f.state.done());
const cli = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: process.env["PATH"], HOME: f.state.dir, DORI_CONFIG: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    out: await new Response(child.stdout).text(),
    err: await new Response(child.stderr).text(),
  };
};

test("real holds CLI survives a fresh process and filters by thread", async () => {
  await f.deps.registry.write({
    ...f.lane,
    status: "closed",
    closedAt: "2026-01-01T13:00:00Z",
    receipt: { outcome: "parked" },
    hold: { reason: "owner wait", resumeWhen: "review first" },
  });
  const r = await cli("holds");
  expect(r.code).toBe(0);
  expect(r.out).toContain("HOLD lifecycle-lane state=parked");
  expect(r.out).toContain("review first");
  expect((await cli("holds", "--thread", "elsewhere")).out).toBe("");
});

test("real CLI requires explicit park and abandon reasons before effects", async () => {
  const park = await cli("park", f.lane.key);
  expect(park.code).toBe(1);
  expect(park.err).toContain("--note is required");
  const emptyNote = await cli("park", f.lane.key, "--note", "", "--resume-when", "review complete");
  expect(emptyNote.code).toBe(1);
  expect(emptyNote.err).toContain("--note is required");
  expect(emptyNote.out).not.toContain("dori <command>");
  const abandon = await cli("close", f.lane.key, "--abandon");
  expect(abandon.code).toBe(1);
  expect(abandon.err).toContain("requires --reason");
  const reopen = await cli("reopen", f.lane.key);
  expect(reopen.code).toBe(3);
  expect(reopen.out).toContain("not closed");
  expect((await f.deps.registry.read(f.lane.key))?.closedAt).toBeUndefined();
});

test("missing saved session is a concise CLI refusal without starting a pane", async () => {
  await f.deps.registry.write({
    ...f.lane,
    status: "closed",
    closedAt: "2026-01-01T13:00:00Z",
    session: f.session,
    sessionFile: f.file,
    receipt: { outcome: "parked" },
  });
  unlinkSync(f.file);
  const r = await cli("reopen", f.lane.key);
  expect(r.code).toBe(1);
  expect(r.err).toContain("saved session or cwd unavailable (ENOENT)");
  expect(r.err).not.toContain("at readResumeFile");
  expect(f.creates()).toBe(0);
});

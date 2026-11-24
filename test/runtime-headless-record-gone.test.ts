import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeHost, hostPidAlive, type Endpoint, type Reservation } from "../src/runtime/headless-record.ts";

const SOCKET = "/tmp/cataly-rpc-testdead/socket";

const lane = (
  stateDir: string,
  id: string,
  files: { reservation?: boolean; endpoint?: Endpoint; stopped?: object },
) => {
  const dir = join(stateDir, "headless", id);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  if (files.reservation ?? true) {
    const reservation: Reservation = {
      ref: { runtime: "headless", id },
      name: "probe-test",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
      role: "lane",
    };
    writeFileSync(join(dir, "reservation.json"), JSON.stringify(reservation), { mode: 0o600 });
  }
  if (files.endpoint) writeFileSync(join(dir, "endpoint.json"), JSON.stringify(files.endpoint), { mode: 0o600 });
  if (files.stopped) writeFileSync(join(dir, "stopped.json"), JSON.stringify(files.stopped), { mode: 0o600 });
};

const ref = (id: string) => ({ runtime: "headless", id }) as const;
const uid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(0, 36);

// A pid that is certainly free: run an instant child to completion and reuse its pid.
const deadPid = (): number => Bun.spawnSync(["/usr/bin/true"]).pid;

const posix = describe.skipIf(process.platform === "win32");

posix("observeHost gone detection for a broker that exited without a stop receipt", () => {
  test("a refused socket with a dead broker pid reports gone", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cataly-gone-"));
    try {
      const pid = deadPid();
      lane(stateDir, uid(1), { endpoint: { socket: SOCKET, key: "k", pid } });
      const seen = await observeHost(stateDir, ref(uid(1)));
      expect(seen.status).toBe("gone");
      expect(seen.detail).toContain(String(pid));
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  test("a refused socket with a live broker pid stays unknown", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cataly-gone-"));
    try {
      lane(stateDir, uid(2), { endpoint: { socket: SOCKET, key: "k", pid: process.pid } });
      const seen = await observeHost(stateDir, ref(uid(2)));
      expect(seen.status).toBe("unknown");
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  test("a lane still starting without an endpoint stays unknown", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cataly-gone-"));
    try {
      lane(stateDir, uid(3), {});
      expect(await observeHost(stateDir, ref(uid(3)))).toMatchObject({ status: "unknown" });
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  test("a stop receipt reports gone before any transport is consulted", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cataly-gone-"));
    try {
      lane(stateDir, uid(4), {
        endpoint: { socket: SOCKET, key: "k", pid: process.pid },
        stopped: { detail: "closed by lead" },
      });
      expect(await observeHost(stateDir, ref(uid(4)))).toMatchObject({ status: "gone" });
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  test("hostPidAlive is true for a live pid and false for a reaped one", () => {
    expect(hostPidAlive(process.pid)).toBe(true);
    expect(hostPidAlive(deadPid())).toBe(false);
  });
});

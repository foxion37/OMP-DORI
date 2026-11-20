import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { runUpdate } from "../src/update/cli.ts";
import { fixture, it } from "./update-setup.ts";

const SUPERVISOR = resolve(import.meta.dir, "../scripts/update-supervisor.ts");

/** A recorded stand-in for the controller's Bun: each invocation exits with the next listed `upstream check` code. */
function supervise(config: Record<string, unknown>, codes: readonly number[]) {
  const f = fixture();
  const path = join(f.directory, "supervised-config.json");
  writeFileSync(path, JSON.stringify(config));
  const count = join(f.directory, "invocations");
  const stub = join(f.directory, "controller-bun");
  writeFileSync(
    stub,
    `#!/bin/sh
n=$(cat '${count}' 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > '${count}'
set -- ${codes.join(" ")}
shift $((n - 1)) 2>/dev/null || exit 2
exit "\${1:-2}"
`,
    { mode: 0o700 },
  );
  const run = async () => {
    const child = Bun.spawn(
      [process.execPath, SUPERVISOR, "--config", path, "--controller", f.directory, "--bun", stub],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const invocations = Number(readFileSync(count, { encoding: "utf8", flag: "a+" }).trim() || 0);
    return { code, stdout, stderr, invocations };
  };
  return { f, run };
}

describe("update supervisor", () => {
  it("a verified live controller lock is retried on the next tick instead of holding the service", async () => {
    const base = fixture();
    const { run } = supervise({ ...base.config, intervalSeconds: 1 }, [5, 2]);
    const result = await run();
    expect(result.stderr).toContain("DORI_SUPERVISOR_RETRY lock=live-controller");
    expect(result.stderr).toContain("DORI_SUPERVISOR_HELD exit=2");
    expect(result.invocations).toBe(2);
    expect(result.code).toBe(2);
  }, 15_000);

  it("a config that omits intervalSeconds uses the shared loader default", async () => {
    const base = fixture();
    const { intervalSeconds: _omitted, ...config } = base.config;
    const { run } = supervise(config, [2]);
    const result = await run();
    expect(result.stderr).not.toContain("DORI_SUPERVISOR_CONFIG_ERROR");
    expect(result.stdout).toContain("DORI_SUPERVISOR_READY");
    expect(result.invocations).toBe(1);
    expect(result.stderr).toContain("DORI_SUPERVISOR_HELD exit=2");
  });

  test("an interval the shared loader rejects is still a configuration error", async () => {
    const base = fixture();
    const { run } = supervise({ ...base.config, intervalSeconds: 0 }, [0]);
    const result = await run();
    expect(result.stderr).toContain("DORI_SUPERVISOR_CONFIG_ERROR");
    expect(result.invocations).toBe(0);
    expect(result.code).toBe(2);
  });
});

describe("controller lock conflicts", () => {
  const conflict = async (lock: unknown) => {
    const f = fixture();
    const config = join(f.directory, "config.json");
    writeFileSync(config, JSON.stringify(f.config));
    mkdirSync(f.config.root, { recursive: true, mode: 0o700 });
    const path = join(f.config.root, "controller.lock");
    const text = typeof lock === "string" ? lock : JSON.stringify(lock);
    writeFileSync(path, text, { mode: 0o600 });
    const code = await runUpdate(["check", "--config", config]);
    // No conflict outcome may release or rewrite the retained lock.
    expect(readFileSync(path, "utf8")).toBe(text);
    return code;
  };
  const owner = { version: 1, pid: process.pid, host: hostname(), nonce: "live-owner" };

  it("a live same-host owner that predates its lock is retryable", async () => {
    expect(await conflict({ ...owner, at: new Date().toISOString() })).toBe(5);
  });

  test("a live PID that started after the lock was written is a reused PID and stays held", async () => {
    expect(await conflict({ ...owner, at: "2000-01-01T00:00:00.000Z" })).toBe(2);
  });

  test("a lock owned by another host cannot be verified and stays held", async () => {
    expect(await conflict({ ...owner, host: `${hostname()}-other`, at: new Date().toISOString() })).toBe(2);
  });

  test("a dead owner and a malformed lock stay held", async () => {
    expect(await conflict({ ...owner, pid: 2147483647, at: new Date().toISOString() })).toBe(2);
    expect(await conflict("{")).toBe(2);
  });
});

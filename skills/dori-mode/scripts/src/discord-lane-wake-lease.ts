import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FlowDeps } from "./done-flow.ts";

export type WakeLease = { readonly argv: readonly string[]; readonly session: string; readonly cwd: string };

const TIMEOUT_MS = 8_000;
const tokenList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id: unknown) => typeof id === "string");

export async function wakeLeaseState(deps: FlowDeps, check: WakeLease): Promise<"free" | "held" | "unknown"> {
  const result = await deps.run([...check.argv, "session", "lease", "--json", "--", check.session], {
    cwd: check.cwd,
    timeoutMs: TIMEOUT_MS,
  });
  if (result.code !== 0) return "unknown";
  const report: unknown = JSON.parse(result.out);
  if (!report || typeof report !== "object" || !("held" in report) || !("unknown" in report)) return "unknown";
  if (!tokenList(report.held) || !tokenList(report.unknown) || report.unknown.length !== 0) return "unknown";
  if (report.held.length === 0) return "free";
  return report.held.length === 1 && report.held[0] === check.session ? "held" : "unknown";
}

/** Pinned OMP hashes the profile-independent session owner path with the file-lock wrapper's `.lock` suffix. */
export async function ownsWakeLease(deps: FlowDeps, check: WakeLease, pid: number): Promise<boolean> {
  if (process.platform !== "linux" || !/^[A-Za-z0-9_-]{1,128}$/.test(check.session)) return false;
  if ((await wakeLeaseState(deps, check)) !== "held") return false;
  const env = deps.env ?? process.env;
  const xdg = env["XDG_STATE_HOME"];
  const config = join(env["HOME"] || homedir(), env["PI_CONFIG_DIR"] || ".omp");
  const xdgRoot = xdg ? resolve(check.cwd, xdg, "omp") : undefined;
  const root = xdgRoot && existsSync(xdgRoot) ? xdgRoot : config;
  const dir = env["PI_TEST_SESSION_OWNERS_DIR"] || join(root, "run", "session-owners");
  const path = resolve(check.cwd, dir, `${check.session}.lock`);
  const high = Bun.hash.xxHash64(path, 0x4f4d502d4c4f434bn).toString(16).padStart(16, "0");
  const low = Bun.hash.xxHash64(path, 0x50492d46494c454cn).toString(16).padStart(16, "0");
  const name = `@omp-file-lock-${high}${low}`;
  const sockets = await deps.run(["cat", "/proc/net/unix"], { timeoutMs: TIMEOUT_MS });
  if (sockets.code !== 0) return false;
  const bound = sockets.out.split("\n").flatMap((line) => {
    const row = /^\S+\s+\S+\s+\S+\s+\S+\s+0002\s+\S+\s+(\d+)\s+(\S+)\s*$/.exec(line.trim());
    return row?.[1] && row[2] === name ? [row[1]] : [];
  });
  const [inode] = bound;
  if (!inode || bound.length !== 1) return false;
  const files = await deps.run(
    ["find", `/proc/${pid}/fd`, "-mindepth", "1", "-maxdepth", "1", "-type", "l", "-printf", "%l\n"],
    { timeoutMs: TIMEOUT_MS },
  );
  return files.code === 0 && files.out.split("\n").includes(`socket:[${inode}]`);
}

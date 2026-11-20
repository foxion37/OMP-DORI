import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportNativeCache } from "../src/release/native-cache.ts";
import { processCwds, processStart } from "../src/release/process-cwd.ts";
import { nativeCacheFixture, overlayFixture, ownProcessFiles } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a Linux process table whose working directories cannot be read is unavailable, not empty", () => {
  expect(processCwds(["999999999"], "linux")).toBeNull();
});

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every directory.
const posix = test.skipIf(process.platform === "win32");

posix("when no working directory can be read, the report says so for every identity", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-cwd-")));
  roots.push(root);
  const home = join(root, "home");
  const f = overlayFixture(join(root, "source"), join(root, "upstream"), true, `unused ${root}`);
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  rmSync(f.source, { recursive: true });

  const entries = reportNativeCache(home, [], [], () => null, { files: ownProcessFiles });

  expect(entries.map((entry) => [entry.directory, entry.protectedBy])).toEqual([
    [receipt.directory, ["process working directories unavailable"]],
  ]);
  expect(existsSync(receipt.directory)).toBe(true);
});

test("a live process whose working directory cannot be read is reported by pid; an exited one is not", async () => {
  if (process.platform !== "linux") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-cwd-")));
  roots.push(root);
  const home = join(root, "home");
  const f = overlayFixture(join(root, "source"), join(root, "upstream"), true, `hidden ${root}`);
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  rmSync(f.source, { recursive: true });
  // Not dumpable, so even its own user cannot read its /proc cwd; it works inside the cache entry.
  const holder = Bun.spawn(
    [
      "python3",
      "-c",
      "import ctypes,sys; ctypes.CDLL(None).prctl(4,0,0,0,0); print('ready', flush=True); sys.stdin.readline()",
    ],
    { cwd: receipt.directory, stdin: "pipe", stdout: "pipe" },
  );
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toBe("ready\n");
    const pid = String(holder.pid);
    const read = processCwds([pid, "999999999", String(process.pid)], "linux");
    expect(read?.unreadable).toEqual([pid]);
    expect(read?.cwds.has(String(process.pid))).toBe(true);
    const [entry] = reportNativeCache(home, [], []);
    // One reason per such process of this user, with its start and arguments; its cwd is the entry, but unknown.
    const unavailable = entry?.protectedBy.find((reason) =>
      reason.startsWith(`unreadable working directory of process ${pid}@${processStart(pid)} (`),
    );
    expect(unavailable).toContain("python3 -c import ctypes");
    // Another user's process cannot enter a 0700 entry, so pid 1 (root's) is judged by its arguments alone.
    expect(entry?.protectedBy.some((reason) => reason.startsWith("unreadable working directory of process 1@"))).toBe(
      false,
    );
    expect(entry?.protectedBy).not.toContain(`process ${pid}`);
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
});

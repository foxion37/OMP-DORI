import { expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportNativeCache } from "../src/release/native-cache.ts";

// POSIX-only: the release cache refuses any path carrying the group or world write bits, and Windows reports
// 0666/0777 for every file and directory.
const posix = test.skipIf(process.platform === "win32");

posix("exclusive bytes include directories and internal hardlinks once, but not externally shared files", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dori-cache-bytes-")));
  try {
    const entry = join(home, ".cache/omp-dori", `native-${process.platform}-${process.arch}-${"a".repeat(64)}`);
    const child = join(entry, "child");
    mkdirSync(child, { recursive: true, mode: 0o700 });
    const internal = join(entry, "internal");
    writeFileSync(internal, "internal");
    linkSync(internal, join(child, "internal-link"));
    const external = join(home, "external");
    writeFileSync(external, "external data is not exclusive");
    linkSync(external, join(child, "external-link"));
    const symlink = join(entry, "symbolic");
    symlinkSync(external, symlink);
    const expected = [entry, child, internal, symlink].reduce((sum, path) => sum + lstatSync(path).size, 0);

    const [reported] = reportNativeCache(home, [], []);

    expect(reported?.bytes).toBe(expected);
    expect(lstatSync(internal).nlink).toBe(2);
    expect(lstatSync(external).nlink).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

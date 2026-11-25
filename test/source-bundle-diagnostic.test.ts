import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readSourceBundleDiagnostic } from "../src/release/source-bundle-diagnostic.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";

const source = resolve(import.meta.dir, "..");
test("diagnostic bundle content validation does not grant managed installation admission", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cataly-diagnostic-bundle-"));
  try {
    for (const name of ["native-omp.lock", "native-omp.patch"]) copyFileSync(join(source, name), join(root, name));
    const diagnostic = readSourceBundleDiagnostic(root);
    expect(diagnostic.lock.nativeVersion).toBeDefined();
    expect(diagnostic.identity).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform === "win32") expect(() => readSourceBundle(root)).toThrow("Group/world-writable");
    else expect(readSourceBundle(root)).toEqual(diagnostic);
    const patch = join(root, "native-omp.patch");
    writeFileSync(patch, "changed patch");
    expect(() => readSourceBundleDiagnostic(root)).toThrow("patch digest differs");
    copyFileSync(join(source, "native-omp.patch"), patch);
    const path = join(root, "native-omp.lock");
    const lock = JSON.parse(readFileSync(path, "utf8"));
    lock.unexpected = true;
    writeFileSync(path, JSON.stringify(lock));
    expect(() => readSourceBundleDiagnostic(root)).toThrow("Invalid source bundle lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

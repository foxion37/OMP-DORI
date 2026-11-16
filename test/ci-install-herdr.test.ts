import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/ci-install-herdr.sh");
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-ci-download-"));
  const bin = join(dir, "mocks");
  const out = join(dir, "out");
  mkdirSync(bin);
  mkdirSync(out);
  const mock = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  mock("timeout", `test "$1" = --kill-after=5s; test "$2" = 60s; shift 2; exec "$@"`);
  mock("sleep", `echo "$1" >> "$CASE_DIR/sleeps"`);
  mock(
    "gh",
    `test "$1 $2 $3 $4 $5 $6 $7" = 'release download v0.9.5 -R herdrdev/herdr -p herdr-linux-x86_64'
test "$8" = -O; test "\${10}" = --clobber
n=0; [ ! -f "$CASE_DIR/count" ] || n=$(cat "$CASE_DIR/count")
n=$((n+1)); echo "$n" > "$CASE_DIR/count"
printf partial > "$9"
if [ "$n" -le "$FAILURES" ]; then exit "$FAIL_CODE"; fi
printf '%s' "$PAYLOAD" > "$9"`,
  );
  mock(
    "sha256sum",
    `test "$1" = -c; test "$2" = -
read -r hash path
test "$hash" = 14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d
test "$(cat "$path")" = verified`,
  );
  writeFileSync(join(out, "herdr"), "previous");
  const run = (failures: number, payload = "verified", failCode = 1) =>
    Bun.spawnSync(["bash", script, out], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"]}`,
        CASE_DIR: dir,
        FAILURES: String(failures),
        PAYLOAD: payload,
        FAIL_CODE: String(failCode),
      },
    });
  return {
    dir,
    out,
    run,
    read: (file: string) => readFileSync(join(dir, file), "utf8").trim(),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test.each([0, 2])("installs only verified bytes after %s transient failures", (failures) => {
  const f = fixture();
  try {
    expect(f.run(failures).exitCode).toBe(0);
    expect(f.read("count")).toBe(String(failures + 1));
    expect(f.read("out/herdr")).toBe("verified");
    expect(readdirSync(f.out)).toEqual(["herdr"]);
    if (failures) expect(f.read("sleeps")).toBe("20\n40");
  } finally {
    f.close();
  }
});

test.each([1, 124])("bounds retries and cleans partial bytes on download exit %s", (code) => {
  const f = fixture();
  try {
    expect(f.run(3, "verified", code).exitCode).toBe(22);
    expect(f.read("count")).toBe("3");
    expect(f.read("out/herdr")).toBe("previous");
    expect(readdirSync(f.out)).toEqual(["herdr"]);
  } finally {
    f.close();
  }
});

test("checksum rejection preserves existing binary and cleans download", () => {
  const f = fixture();
  try {
    expect(f.run(0, "tampered").exitCode).not.toBe(0);
    expect(f.read("count")).toBe("1");
    expect(f.read("out/herdr")).toBe("previous");
    expect(readdirSync(f.out)).toEqual(["herdr"]);
  } finally {
    f.close();
  }
});

test("hc gate requires its E2E file instead of reporting skipped success", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
  expect(workflow).toContain("test -f test/e2e-hc.test.ts\n          bun test test/e2e-hc.test.ts");
  expect(workflow).toContain("test -f test/e2e-hc-deploy.test.ts\n          bun test test/e2e-hc-deploy.test.ts");
  expect(workflow).not.toContain("SKIP e2e-hc");
});

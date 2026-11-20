import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These installer/gate cases use POSIX executables and a shell PATH.
const posix = test.skipIf(process.platform === "win32");

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

posix.each([0, 2])("installs only verified bytes after %s transient failures", (failures) => {
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

posix.each([1, 124])("bounds retries and cleans partial bytes on download exit %s", (code) => {
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

posix("checksum rejection preserves existing binary and cleans download", () => {
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

posix("the hc gate requires both E2E files and runs each through bun", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8")) as {
    jobs?: Record<string, { steps?: readonly { name?: string; run?: string }[] }>;
  };
  const step = workflow.jobs?.["e2e-hc"]?.steps?.find((candidate) => candidate.name === "hc e2e");
  const script = step?.run;
  if (!script) throw new Error("ci.yml must keep the named hc e2e step");
  const gate = (present: readonly string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "dori-ci-hc-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const calls = join(dir, "bun-calls");
      writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
      mkdirSync(join(dir, "test"));
      for (const file of present) writeFileSync(join(dir, file), "");
      const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` },
      });
      const invoked = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
      return { code: result.exitCode, invoked };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  expect(gate([]).code).not.toBe(0);
  expect(gate(["test/e2e-hc.test.ts"]).code).not.toBe(0);
  expect(gate(["test/e2e-hc.test.ts", "test/e2e-hc-deploy.test.ts"])).toEqual({
    code: 0,
    invoked: ["test test/e2e-hc.test.ts", "test test/e2e-hc-deploy.test.ts"],
  });
});

import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { requiredSourceRequest } from "../../test/fixtures/omp-native-host/required-source.ts";
import { useConfig } from "./fake-pi.ts";

for (const boundary of ["session", "provider"] as const) {
  test(`missing required overlays block real ${boundary} transport only for role sessions`, async () => {
    const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
    const before = keys.map((key) => process.env[key]);
    const home = dirname(useConfig(""));
    process.env["HOME"] = home;
    process.env["DORI_OMP_ULW_PATH"] = join(home, ".cache/omp-dori", `omp-ulw-${"0".repeat(64)}`, "index.ts");
    delete process.env["HERDR_PANE_ID"];
    delete process.env["HC_TERMINAL_ID"];
    try {
      for (const role of ["lane", "dori", undefined] as const) {
        const cwd = join(home, role ?? "ordinary");
        mkdirSync(cwd);
        const result = await requiredSourceRequest(join(import.meta.dir, "../index.ts"), cwd, role, boundary);
        expect(result.errors.filter((error) => error.event === "session_start")).toEqual([]);
        expect(result.requests).toBe(role ? 0 : 1);
      }
    } finally {
      keys.forEach((key, index) => {
        if (before[index] === undefined) delete process.env[key];
        else process.env[key] = before[index];
      });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const input of [
  { name: "consumer directory import", indexed: false, managed: true, failure: "import" },
  { name: "consumer directory factory", indexed: false, managed: true, failure: "factory" },
  { name: "consumer entry import", indexed: true, managed: true, failure: "import" },
  { name: "consumer entry factory", indexed: true, managed: true, failure: "factory" },
  { name: "external directory factory", indexed: false, managed: false, failure: "factory" },
  { name: "successful consumer directory", indexed: false, managed: true, failure: "none" },
]) {
  for (const boundary of ["session", "provider"] as const) {
    test(`${input.name} load preserves required ${boundary} cancellation and ordinary sessions`, async () => {
      const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
      const before = keys.map((key) => process.env[key]);
      const stateDir = useConfig("");
      const home = dirname(stateDir);
      process.env["HOME"] = home;
      delete process.env["DORI_OMP_ULW_PATH"];
      delete process.env["HERDR_PANE_ID"];
      delete process.env["HC_TERMINAL_ID"];
      try {
        const dependency = input.managed
          ? join(home, ".dori/releases/consumer-dependencies", `omp-ulw-${"a".repeat(40)}-${"b".repeat(64)}`)
          : join(home, "external-overlay");
        mkdirSync(dependency, { recursive: true });
        const error = 'throw new Error("intentional dependency failure");';
        writeFileSync(
          join(dependency, "index.ts"),
          input.failure === "import"
            ? `${error} export default () => {};\n`
            : `export default () => { ${input.failure === "factory" ? error : ""} };\n`,
        );
        writeFileSync(
          join(home, "config.json"),
          JSON.stringify({ stateDir, ompUlwPath: input.indexed ? join(dependency, "index.ts") : dependency }),
        );
        for (const role of ["lane", "dori", undefined] as const) {
          const cwd = join(home, role ?? "ordinary");
          mkdirSync(cwd);
          const result = await requiredSourceRequest(join(import.meta.dir, "../index.ts"), cwd, role, boundary);
          expect(result.errors.filter((error) => error.event === "session_start")).toEqual([]);
          expect(result.requests).toBe(role && input.managed && input.failure !== "none" ? 0 : 1);
          if (role && input.managed && input.failure !== "none")
            expect(result.errors.some((error) => error.error.includes("intentional dependency failure"))).toBe(true);
        }
      } finally {
        keys.forEach((key, index) => {
          if (before[index] === undefined) delete process.env[key];
          else process.env[key] = before[index];
        });
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

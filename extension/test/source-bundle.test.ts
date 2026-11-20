import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { requiredSourceRequest } from "../../test/fixtures/omp-native-host/required-source.ts";
import { useConfig } from "./fake-pi.ts";

/**
 * The native fixture's credential sqlite file stays open for the life of the test process, so Windows refuses to
 * delete the temporary home that holds it; POSIX unlinks open files and keeps failing loudly here.
 */
const removeHome = (home: string): void => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM")) throw error;
  }
};

for (const input of [
  { name: "missing required overlays", failure: "missing" },
  { name: "consumer directory import", indexed: false, managed: true, failure: "import" },
  { name: "consumer directory factory", indexed: false, managed: true, failure: "factory" },
  { name: "consumer entry import", indexed: true, managed: true, failure: "import" },
  { name: "consumer entry factory", indexed: true, managed: true, failure: "factory" },
  { name: "external directory factory", indexed: false, managed: false, failure: "factory" },
  { name: "successful consumer directory", indexed: false, managed: true, failure: "none" },
] as const) {
  for (const boundary of ["session", "provider"] as const) {
    for (const role of ["lane", "dori", undefined] as const) {
      // One native session lifecycle per test deadline; the process environment is shared.
      test.serial(`${input.name} at the ${boundary} boundary for ${role ?? "ordinary"}`, async () => {
        const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
        const before = keys.map((key) => process.env[key]);
        const stateDir = useConfig("");
        const home = dirname(stateDir);
        try {
          process.env["HOME"] = home;
          delete process.env["HERDR_PANE_ID"];
          delete process.env["HC_TERMINAL_ID"];
          if (input.failure === "missing") {
            process.env["DORI_OMP_ULW_PATH"] = join(home, ".cache/omp-dori", `omp-ulw-${"0".repeat(64)}`, "index.ts");
          } else {
            delete process.env["DORI_OMP_ULW_PATH"];
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
          }
          const cwd = join(home, role ?? "ordinary");
          mkdirSync(cwd);
          const result = await requiredSourceRequest(join(import.meta.dir, "../index.ts"), cwd, role, boundary);
          const blocked =
            role !== undefined && (input.failure === "missing" || (input.managed && input.failure !== "none"));
          expect(result.errors.filter((error) => error.event === "session_start")).toEqual([]);
          expect(result.requests).toBe(blocked ? 0 : 1);
          if (blocked && input.failure !== "missing")
            expect(result.errors.some((error) => error.error.includes("intentional dependency failure"))).toBe(true);
        } finally {
          keys.forEach((key, index) => {
            if (before[index] === undefined) delete process.env[key];
            else process.env[key] = before[index];
          });
          removeHome(home);
        }
      });
    }
  }
}

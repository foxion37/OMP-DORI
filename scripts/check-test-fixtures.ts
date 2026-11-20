import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertNativeHost } from "../test/fixtures/omp-native-host/host.ts";

/** Check prerequisites only; the unchanged native tests still prove fixture behavior. */
export async function checkTestFixtures(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  for (const [name, entry] of [
    ["bound ULW fixture", join(root, "ref/omp-ulw/index.ts")],
    ["DORI_TEST_COMPAT_ULW_ENTRY", env["DORI_TEST_COMPAT_ULW_ENTRY"]],
  ] as const) {
    if (!entry || !isAbsolute(entry) || !statSync(entry, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${name} must name an existing absolute fixture file`);
    }
  }
  await assertNativeHost(env);
}

if (import.meta.main) {
  try {
    await checkTestFixtures(resolve(import.meta.dir, ".."));
    console.log("CI_FIXTURES_OK native=18.20.0 ulw=present compatibility=present");
  } catch (error) {
    console.error(`CI_FIXTURES_FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Prepare the exact fixtures in CONTRIBUTING.md#run-the-gates before running the full gate.");
    process.exitCode = 1;
  }
}

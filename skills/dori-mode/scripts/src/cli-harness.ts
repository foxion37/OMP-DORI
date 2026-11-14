import { main } from "../../../../src/cli.ts";
import { defaultDeps } from "../../../../src/harness.ts";
import { ConfigError, hooksSettled } from "../../../../src/hooks.ts";
import { Refusal } from "../../../../src/refusal.ts";
import { ConfigError as RuntimeConfigError, RuntimeChoiceError } from "../../../../src/runtime/select.ts";

/** The root CLI lifecycle, including its exit codes, hooks and final usage flush. */
export const runHarness = async (argv: readonly string[]): Promise<number> => {
  const deps = defaultDeps();
  try {
    return await main(argv, deps);
  } catch (error) {
    if (
      !(
        error instanceof Refusal ||
        error instanceof ConfigError ||
        error instanceof RuntimeConfigError ||
        error instanceof RuntimeChoiceError
      )
    )
      throw error;
    console.error(error.message);
    return 2;
  } finally {
    await hooksSettled();
    await deps.usage.flush(2000);
  }
};

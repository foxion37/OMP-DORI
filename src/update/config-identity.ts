import { digest } from "./source.ts";
import type { UpdateConfig } from "./types.ts";

/** A changed config cannot adopt the pending jobs of an existing root. */
export function updateConfigurationHash(config: UpdateConfig): string {
  return digest(JSON.stringify(config));
}

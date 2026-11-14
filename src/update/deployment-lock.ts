import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeploymentHeld, DeploymentRetryable, sameProcess } from "./deployment-process.ts";
import type { DeploymentConfig, ProcessIdentity } from "./deployment-types.ts";

/** Wait for a cooperating managed restart to finish; never interrupt its controller or its native actor. */
export async function waitForRestartLock(config: DeploymentConfig, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + config.healthTimeoutMs;
  while (lstatSync(config.restartLock, { throwIfNoEntry: false })) {
    try {
      const owner = JSON.parse(readFileSync(join(config.restartLock, "owner.json"), "utf8")) as ProcessIdentity;
      if (
        Number.isSafeInteger(owner.pid) &&
        typeof owner.startTicks === "string" &&
        typeof owner.bootId === "string" &&
        typeof owner.executable === "string" &&
        !sameProcess(owner)
      )
        return;
    } catch {
      // A concurrent claim writes its identity immediately after creating the directory.
    }
    if (signal?.aborted) throw new DeploymentHeld("deployment interrupted while a managed restart held its lock");
    if (performance.now() >= deadline)
      throw new DeploymentRetryable("managed restart lock did not become available within the health bound");
    await Bun.sleep(50);
  }
}

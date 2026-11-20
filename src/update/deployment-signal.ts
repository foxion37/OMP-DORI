// Bound termination of one recorded process incarnation. The binding primitive is the platform adapter's: Linux
// signals through a pidfd so a reused pid cannot be retargeted, macOS re-reads identity immediately before kill(2).
import { platform } from "../platform/index.ts";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import type { ProcessIdentity } from "./deployment-types.ts";

const libcRequired = "Linux libc pidfd_open and pidfd_send_signal are required for native replacement";

/**
 * Signal the recorded process only while it is still the incarnation the caller checked. Linux re-runs the same
 * `sameProcess` check after the pidfd binds the pid and before it signals, so a process that re-execs into another
 * image — same pid, same start time, different executable — is refused instead of signalled. macOS has no pidfd, so a
 * PID reused between that check and kill(2) cannot be excluded; the window is one syscall. A pid that vanished inside
 * that window surfaces as ESRCH from the binding and answers false, as it did before the adapter. Any other failure
 * says either that the process is no longer ours or that this host cannot bind at all, and only a fresh identity read
 * tells the two apart, so the caller re-checks after every failure.
 */
export function terminateBoundProcess(expected: ProcessIdentity): boolean {
  if (!sameProcess(expected)) return false;
  try {
    platform.terminate(expected.pid, { startTicks: expected.startTicks, bootId: expected.bootId }, () =>
      sameProcess(expected),
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    const message = error instanceof Error ? error.message : "";
    if (message === libcRequired) throw new DeploymentHeld(message);
    if (!sameProcess(expected)) return false;
    throw new DeploymentHeld(message);
  }
}

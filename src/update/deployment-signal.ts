import { constants } from "node:os";
import { dlopen } from "bun:ffi";
import { DeploymentHeld, sameProcess } from "./deployment-process.ts";
import type { ProcessIdentity } from "./deployment-types.ts";

/** Bind a kernel pidfd before the final start/boot/executable check; PID reuse after that check cannot retarget the signal. */
export function terminateBoundProcess(expected: ProcessIdentity): boolean {
  if (!sameProcess(expected)) return false;
  if (process.platform === "darwin") return terminateCheckedProcess(expected);
  try {
    const native = dlopen("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
    } as const);
    let fd = -1;
    try {
      fd = native.symbols.pidfd_open(expected.pid, 0);
      if (fd < 0) {
        if (!sameProcess(expected)) return false;
        throw new DeploymentHeld("native pidfd identity binding failed");
      }
      if (!sameProcess(expected)) return false;
      if (native.symbols.pidfd_send_signal(fd, constants.signals.SIGTERM, null, 0) !== 0) {
        if (!sameProcess(expected)) return false;
        throw new DeploymentHeld("bound native termination failed");
      }
      return true;
    } finally {
      if (fd >= 0) native.symbols.close(fd);
      native.close();
    }
  } catch (error) {
    if (error instanceof DeploymentHeld) throw error;
    throw new DeploymentHeld("Linux libc pidfd_open and pidfd_send_signal are required for native replacement");
  }
}

/**
 * macOS has no pidfd: the start/boot/executable identity is re-read immediately before kill(2). Unlike the Linux
 * binding, a PID that is reused between that check and the signal cannot be excluded; the window is one syscall.
 */
function terminateCheckedProcess(expected: ProcessIdentity): boolean {
  if (!sameProcess(expected)) return false;
  try {
    process.kill(expected.pid, constants.signals.SIGTERM);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH" || !sameProcess(expected)) return false;
    throw new DeploymentHeld("checked native termination failed");
  }
  return true;
}

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { SHELLS } from "../runtime/foreground.ts";
import type { Front } from "../runtime/herdr/probe.ts";
import { processIdentity, sameProcess } from "./deployment-process.ts";
import type { DeploymentConfig } from "./deployment-types.ts";

/** A foreground child shell is never the pane's bare prompt, including suspended/background native owners. */
export function bareRootShell(config: DeploymentConfig, front: Front): boolean {
  if (
    !front.shell ||
    !front.rootPid ||
    front.pgid !== front.rootPid ||
    front.processes?.length !== 1 ||
    front.processes[0]?.pid !== front.rootPid
  )
    return false;
  const owner = readPaneState(config.stateDir, config.pane);
  if (owner && processIdentity(owner.pid)) return false;
  const identity = processIdentity(front.rootPid);
  if (!identity || !SHELLS.has(basename(identity.executable))) return false;
  try {
    const entry = front.processes[0]!;
    const argv = readFileSync(`/proc/${identity.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const argv0 = argv[0] ?? "";
    const invoked = basename(argv0).replace(/^-/, "");
    const matchesImage = isAbsolute(argv0)
      ? realpathSync(argv0) === realpathSync(`/proc/${identity.pid}/exe`)
      : invoked === basename(identity.executable);
    const fields = readFileSync(`/proc/${identity.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    if (
      basename(entry.name).replace(/^-/, "") !== invoked ||
      !matchesImage ||
      argv.length !== entry.argv.length ||
      argv.some((arg, index) => arg !== entry.argv[index]) ||
      argv.slice(1).some((arg) => !/^-[il]+$|^--(?:login|interactive|noprofile|norc)$/.test(arg)) ||
      Number(fields[2]) !== front.pgid ||
      (Number(fields[5]) > 0 && Number(fields[5]) !== front.pgid) ||
      readdirSync(`/proc/${identity.pid}/task`).some(
        (task) => readFileSync(`/proc/${identity.pid}/task/${task}/children`, "utf8").trim() !== "",
      )
    )
      return false;
    return sameProcess(identity);
  } catch {
    return false;
  }
}

import { parseCatalyRole } from "../../skills/cataly-mode/scripts/src/session-compat.ts";
import type { NativeHarnessRole } from "./headless-protocol.ts";
import { classifyOmpArgv, nonPidPreservingPrefix } from "./omp-argv.ts";
import { NATIVE_VALUE_FLAGS } from "./omp-options.ts";

const FORBIDDEN_FLAGS =
  /^(?:--(?:cwd|mode|no-ui|no-session|session-dir|session|resume|continue|restore|fork|from-claude|from-codex|provider-session-id|goal|plan|plan-yolo|plan-yolo-into|approval-mode|auto-approve|yolo|print|cataly-(?:launch-model|monitor-bootstrap|lane-receiver))|-[crp].*|--)(?:=|$)/;

/** Headless uses exact native argv, but never accepts a caller-supplied mode or transcript selector. */
export const headlessArgv = (template: readonly string[], model: string, harnessRole?: NativeHarnessRole): string[] => {
  if (template.at(-1) !== "{prompt}" || template.slice(0, -1).some((arg) => arg.includes("{prompt}")))
    throw new Error("headless agentCommand must end in one positional {prompt}");
  const argv = template.slice(0, -1);
  const parsed = classifyOmpArgv(argv);
  if (parsed.kind !== "omp" || nonPidPreservingPrefix(argv) || argv[0] !== parsed.command[0])
    throw new Error("headless sessions require a direct native OMP agentCommand without shell or forking launchers");
  const role = harnessRole === undefined ? "lane" : "cataly";
  const launch = argv.slice(0, parsed.argsAt);
  let roleSeen = false;
  for (let at = parsed.argsAt; at < argv.length; at++) {
    const arg = argv[at]!;
    const [flag, attached] = arg.split(/=(.*)/s, 2);
    if (!arg.startsWith("-") || FORBIDDEN_FLAGS.test(arg))
      throw new Error("headless agentCommand cannot add initial text or override mode, session, goal or approval");
    if (flag === "--cataly-role") {
      const explicit = parseCatalyRole(attached ?? argv[++at]);
      // The shared agentCommand is a lane template. Only a harness role may reinterpret its lane selector.
      if (roleSeen || (explicit !== role && !(harnessRole && explicit === "lane")))
        throw new Error(`headless agentCommand may only select the ${role} role`);
      roleSeen = true;
      continue;
    }
    launch.push(arg.replaceAll("{model}", () => model));
    if (
      attached === undefined &&
      flag !== undefined &&
      (Object.hasOwn(NATIVE_VALUE_FLAGS, flag) || flag === "--profile" || flag === "--alias")
    ) {
      const value = argv[++at];
      if (!value || value.startsWith("-")) throw new Error(`headless agentCommand has no value for ${flag}`);
      launch.push(value.replaceAll("{model}", () => model));
    }
  }
  return [...launch, "--cataly-role", role];
};

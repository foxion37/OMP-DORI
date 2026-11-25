import { UpdateError } from "./config.ts";
import { NATIVE_VALUE_FLAGS } from "../runtime/omp-options.ts";

export const RESUME_FLAG =
  /^(?:--resume|--continue|--session|--restore|--fork|--from-claude|--from-codex|-r|-c)(?:=|$)/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/{}*?[\],][^\s{}*?[\],]*$/;
const OWNED_FLAG =
  /^(?:--system-prompt|--append-system-prompt|--system-prompt-template|--profile|--alias|-e|--extensions?|--trusted-extension|--hook|--cataly-(?:role|launch-model|monitor-bootstrap|lane-receiver))(?:=|$)/;

export const isNativeOwnedFlag = (arg: string): boolean => OWNED_FLAG.test(arg);

// OMP v19.0.1 cli/flag-tables.ts VALUELESS_FLAGS, including the parser's short aliases.
export const NATIVE_BOOLEAN_FLAGS: Readonly<Record<string, true>> = {
  "--help": true,
  "-h": true,
  "--version": true,
  "-v": true,
  "--allow-home": true,
  "--continue": true,
  "-c": true,
  "--from-claude": true,
  "--from-codex": true,
  "--no-session": true,
  "--no-tools": true,
  "--no-judge": true,
  "--no-spotlight": true,
  "--offline": true,
  "--no-lsp": true,
  "--no-pty": true,
  "--hide-thinking": true,
  "--advisor": true,
  "--wait-async": true,
  "--external-thinking": true,
  "--prewalk": true,
  "--no-prewalk": true,
  "--plan-yolo": true,
  "--print": true,
  "-p": true,
  "--print-thoughts": true,
  "--no-extensions": true,
  "--no-skills": true,
  "--no-rules": true,
  "--no-context-files": true,
  "--no-title": true,
  "--no-ui": true,
  "--auto-approve": true,
  "--yolo": true,
};

export function checkNativeArgv(argv: readonly string[], label: string): void {
  if (argv.some((arg) => RESUME_FLAG.test(arg))) {
    throw new UpdateError(`${label} must start a fresh process/context without session resume`);
  }
  if (argv.at(-1) !== "{prompt}")
    throw new UpdateError(`${label} native OMP argv must end with the {prompt} positional`);
  if (argv.slice(0, -1).some(isNativeOwnedFlag)) {
    throw new UpdateError(
      `${label} native OMP argv must leave controller-owned prompt/profile/alias/extension/hook/Cataly-role flags unset`,
    );
  }
  if (argv.some((arg) => /^(?:--provider|--models)(?:=|$)/.test(arg))) {
    throw new UpdateError(`${label} native OMP requires one exact --model without --provider or --models`);
  }
  let models = 0;
  for (let at = 1; at < argv.length - 1; at++) {
    const arg = argv[at]!;
    if (arg === "--") {
      if (at !== argv.length - 2) {
        throw new UpdateError(`${label} native OMP permits -- only immediately before the final prompt positional`);
      }
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (NATIVE_VALUE_FLAGS[flag] !== true) continue;
    const value = equals < 0 ? argv[++at] : arg.slice(equals + 1);
    if (!value || value.startsWith("-") || value.includes("{prompt}") || value.includes("{brief}")) {
      throw new UpdateError(`${label} native OMP ${flag} requires a value before the final prompt positional`);
    }
    if (flag === "--mode" && value !== "json") {
      throw new UpdateError(`${label} native OMP requires --mode json for final-message evidence`);
    }
    if (flag === "--model") {
      models++;
      if (!MODEL_ID.test(value) || value.startsWith("pi/")) {
        throw new UpdateError(`${label} native OMP requires exactly one provider-qualified --model`);
      }
    }
  }
  if (models !== 1) throw new UpdateError(`${label} native OMP requires exactly one provider-qualified --model`);
}

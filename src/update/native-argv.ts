import { UpdateError } from "./config.ts";

const RESUME_FLAG = /^(?:--resume|--continue|--session|--restore|--fork|--from-claude|--from-codex|-r|-c)(?:=|$)/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/{}*?\[\],][^\s{}*?\[\],]*$/;
const OWNED_FLAG =
  /^(?:--system-prompt|--append-system-prompt|--system-prompt-template|--profile|--alias|-e|--extensions?|--trusted-extension|--hook|--dori-role)(?:=|$)/;

export const isNativeOwnedFlag = (arg: string): boolean => OWNED_FLAG.test(arg);

// OMP v18.18.8 cli/flag-tables.ts STRING_SETTERS: a value must not swallow the model flag or final prompt.
const NATIVE_VALUE_FLAGS: Record<string, true> = {
  "--cwd": true,
  "--config": true,
  "--add-dir": true,
  "--mode": true,
  "--fork": true,
  "--provider": true,
  "--model": true,
  "--smol": true,
  "--slow": true,
  "--goal": true,
  "--plan": true,
  "--prewalk-into": true,
  "--plan-yolo-into": true,
  "--max-time": true,
  "--warn-cost": true,
  "--max-cost": true,
  "--service-tier": true,
  "--spinner-interval": true,
  "--max-fps": true,
  "--motion": true,
  "--api-key": true,
  "--system-prompt": true,
  "--system-prompt-template": true,
  "--append-system-prompt": true,
  "--provider-session-id": true,
  "--prompt-cache-key": true,
  "--session-dir": true,
  "--models": true,
  "--tools": true,
  "--thinking": true,
  "--export": true,
  "--hook": true,
  "--extension": true,
  "-e": true,
  "--trusted-extension": true,
  "--plugin-dir": true,
  "--skills": true,
  "--approval-mode": true,
};

export function checkNativeArgv(argv: readonly string[], label: string): void {
  if (argv.some((arg) => RESUME_FLAG.test(arg))) {
    throw new UpdateError(`${label} must start a fresh process/context without session resume`);
  }
  if (argv.at(-1) !== "{prompt}")
    throw new UpdateError(`${label} native OMP argv must end with the {prompt} positional`);
  if (argv.slice(0, -1).some(isNativeOwnedFlag)) {
    throw new UpdateError(
      `${label} native OMP argv must leave controller-owned prompt/profile/alias/extension/hook/Dori-role flags unset`,
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

import { basename } from "node:path";
import { OMP_EXECUTABLE, sourceOmpArgv } from "../../../../src/runtime/omp.ts";

const TERMINAL_CONTROL = /\p{Cc}/u;

/** Only known argv launchers and interactive options. OMP itself restores the saved model, not the launch default. */
export function wakeCommand(template: readonly string[]) {
  if (
    !Array.isArray(template) ||
    template.at(-1) !== "{prompt}" ||
    template.some((arg) => typeof arg !== "string" || TERMINAL_CONTROL.test(arg))
  )
    return;
  const executable = template[0] ?? "";
  const bin = basename(executable);
  const scriptAt = bin === "bun" && template[1] === "run" ? 2 : 1;
  let end = 0;
  if (OMP_EXECUTABLE.test(executable)) end = 1;
  else if (bin === "omp-dori" && template[1] === "omp") end = 2;
  else if (sourceOmpArgv(template)) end = template[3] === "--preload" ? 6 : 4;
  else if ((bin === "bun" || bin === "node") && OMP_EXECUTABLE.test(template[scriptAt] ?? "")) end = scriptAt + 1;
  if (!end || end >= template.length || executable.startsWith("-") || executable.includes("=")) return;
  const launch = template.slice(0, end);
  const lease = [...launch];
  for (let i = end; i < template.length - 1; i++) {
    const arg = template[i] ?? "";
    if (arg === "--no-extensions") {
      launch.push(arg);
      continue;
    }
    const inline = /^(--[\w-]+)=(.*)$/.exec(arg);
    const flag = inline?.[1] ?? arg;
    const value = inline?.[2] ?? (i + 1 < template.length - 1 ? template[++i] : undefined);
    if (flag === "--model" && value === "{model}") continue;
    if (flag === "--dori-role" && value === "lane") continue;
    if (!value || value.startsWith("-") || /\{\w+\}/.test(value)) return;
    if (flag !== "--profile" && flag !== "--config" && flag !== "--extension" && flag !== "-e") return;
    launch.push(flag, value);
    if (flag === "--profile") lease.push(flag, value);
  }
  return { launch: [...launch, "--dori-role", "lane"], lease };
}

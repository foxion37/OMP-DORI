import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { procExeTarget } from "../src/update/proc.ts";

// The kernel's short process name, as Linux keeps it in comm and herdr reports it.
export const processName = (pid: number): string =>
  process.platform === "linux"
    ? readFileSync(`/proc/${pid}/comm`, "utf8").trim()
    : basename(procExeTarget(pid)).slice(0, 15);

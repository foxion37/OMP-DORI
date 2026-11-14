import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { processIdentity, sameProcess } from "../update/deployment-process.ts";
import { type ConsumerPaths, readJson, realDirectory, regularFile } from "./files.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function live(value: unknown): number | undefined {
  if (!object(value) || value["role"] !== "dori" || !Number.isSafeInteger(value["pid"])) return undefined;
  const pid = value["pid"] as number;
  if (pid <= 0) throw new Error("Dori runtime PID metadata is invalid");
  const observed = processIdentity(pid);
  if (!observed) {
    if (lstatSync(`/proc/${pid}`, { throwIfNoEntry: false }))
      throw new Error(`Dori PID ${pid} identity is unavailable; activation remains held`);
    return undefined;
  }
  if (typeof value["startTicks"] === "string" && typeof value["bootId"] === "string") {
    if (
      typeof value["executable"] !== "string" ||
      !sameProcess(
        {
          pid,
          startTicks: value["startTicks"],
          bootId: value["bootId"],
          executable: value["executable"],
        },
        observed,
      )
    )
      return undefined;
  }
  // Runtime health files carry PID/session/role metadata rather than the full process receipt.
  // A live PID named by that metadata is conservatively held, even if its heartbeat is stale.
  return pid;
}

/** Read only runtime/monitor receipts and process identity. Native session contents are never opened. */
export function assertNoLiveDori(paths: ConsumerPaths): void {
  const states = new Set<string>([join(paths.dori, "state")]);
  if (regularFile(paths.config)) {
    const config = readJson(paths.config);
    if (!object(config)) throw new Error("Dori config metadata is invalid; check it before activating a release");
    const state = config["stateDir"];
    if (state !== undefined) {
      if (typeof state !== "string" || !state) throw new Error("Dori config stateDir is invalid");
      const expanded = state.startsWith("~/") ? join(paths.home, state.slice(2)) : state;
      states.add(resolve(expanded));
    }
  }
  const configured = process.env["DORI_STATE_DIR"];
  if (configured) states.add(configured.startsWith("~/") ? join(paths.home, configured.slice(2)) : resolve(configured));
  const inspect = (path: string): void => {
    if (!regularFile(path)) return;
    const record = readJson(path);
    const records = [record];
    if (object(record)) records.push(record["runtime"]);
    for (const candidate of records) {
      const pid = live(candidate);
      if (pid !== undefined)
        throw new Error(`Live Dori PID ${pid} holds release activation; stop Dori yourself, then retry`);
    }
  };
  for (const state of states) {
    if (!isAbsolute(state)) throw new Error("Runtime state directory must be absolute");
    for (const kind of ["runtime", "monitors"]) {
      const directory = join(state, kind);
      realDirectory(directory);
      if (!lstatSync(directory, { throwIfNoEntry: false })) continue;
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".json")))
        inspect(join(directory, name));
    }
  }
  inspect(join(paths.root, "active.json"));
}

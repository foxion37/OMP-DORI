import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { dataDir, laneEntry, privateDir, readPrivate } from "../runtime/headless-record.ts";
import { HEADLESS_ADDRESS } from "../runtime/types.ts";
import { object } from "../update/config.ts";
import { processIdentity, sameProcess } from "../update/deployment-process.ts";
import { processExists } from "../update/proc.ts";
import { type ConsumerPaths, readJson, readOptionalJson, realDirectory, regularFile } from "./files.ts";
import { registeredNativeStates } from "./launch-leases.ts";

function live(value: unknown): number | undefined {
  if (!object(value) || value["role"] !== "cataly" || !Number.isSafeInteger(value["pid"])) return undefined;
  const pid = value["pid"] as number;
  if (pid <= 0) throw new Error("Cataly runtime PID metadata is invalid");
  const observed = processIdentity(pid);
  if (!observed) {
    if (processExists(pid)) throw new Error(`Cataly PID ${pid} identity is unavailable; activation remains held`);
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

function assertNoNativeReservations(state: string): void {
  const directory = dataDir(state);
  realDirectory(directory);
  if (!lstatSync(directory, { throwIfNoEntry: false })) return;
  privateDir(directory);
  for (const id of readdirSync(directory).filter((name) => HEADLESS_ADDRESS.test(name))) {
    const entry = laneEntry(state, { runtime: "headless", id });
    const stopped = entry && readPrivate<unknown>(join(entry.dir, "stopped.json"));
    if (
      !object(stopped) ||
      Object.entries(stopped).some(
        ([key, value]) =>
          !["detail", "closedSessionId"].includes(key) ||
          typeof value !== "string" ||
          (key === "closedSessionId" && !value),
      )
    )
      throw new Error(`Native session ${id} holds release activation; stop it through Cataly, then retry`);
  }
}

function assertNoNativeHarnessRoles(paths: ConsumerPaths): void {
  const native = readPrivate<unknown>(join(paths.cataly, "harness-native.json"));
  if (native === undefined) return;
  if (
    !object(native) ||
    Object.keys(native).sort().join() !== "roles,stateDir,version" ||
    native["version"] !== 1 ||
    typeof native["stateDir"] !== "string" ||
    !isAbsolute(native["stateDir"]) ||
    !object(native["roles"])
  )
    throw new Error("Uncertain native harness roles hold release activation");
  if (Object.keys(native["roles"]).length)
    throw new Error("Native harness roles hold release activation; stop Cataly with its harness, then retry");
}

function assertNoControllerLocks(paths: ConsumerPaths): void {
  for (const name of ["duty/lock", "loop/lock", "loop/runner.lock"]) {
    const record = readOptionalJson(join(paths.cataly, name));
    if (record === undefined) continue;
    if (!object(record)) throw new Error(`Uncertain Cataly controller lock ${name} holds release activation`);
    const { pid, nonce } = record;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof nonce !== "string" || !nonce)
      throw new Error(`Uncertain Cataly controller lock ${name} holds release activation`);
    if (processExists(pid))
      throw new Error(`Live Cataly PID ${pid} holds ${name}; stop the controller before retrying`);
  }
}

/** Read only lifecycle receipts and process identity. Native session contents are never opened. */
export function assertNoLiveCataly(paths: ConsumerPaths): void {
  assertNoNativeHarnessRoles(paths);
  assertNoControllerLocks(paths);
  const states = new Set<string>([join(paths.cataly, "state"), ...registeredNativeStates(paths)]);
  if (regularFile(paths.config)) {
    const config = readJson(paths.config);
    if (!object(config)) throw new Error("Cataly config metadata is invalid; check it before activating a release");
    const state = config["stateDir"];
    if (state !== undefined) {
      if (typeof state !== "string" || !state) throw new Error("Cataly config stateDir is invalid");
      const expanded = state.startsWith("~/") ? join(paths.home, state.slice(2)) : state;
      states.add(resolve(expanded));
    }
  }
  const configured = process.env["CATALY_STATE_DIR"];
  if (configured) states.add(configured.startsWith("~/") ? join(paths.home, configured.slice(2)) : resolve(configured));
  const inspect = (path: string): void => {
    if (!regularFile(path)) return;
    const record = readJson(path);
    const records = [record];
    if (object(record)) records.push(record["runtime"]);
    for (const candidate of records) {
      const pid = live(candidate);
      if (pid !== undefined)
        throw new Error(`Live Cataly PID ${pid} holds release activation; stop Cataly yourself, then retry`);
    }
  };
  for (const state of states) {
    if (!isAbsolute(state)) throw new Error("Runtime state directory must be absolute");
    assertNoNativeReservations(state);
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

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { IntakeSpec, MonitorSet, MonitorSpec, ProcessIdentity } from "./deployment-types.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const processReceipt = (value: unknown): ProcessIdentity => {
  if (
    !record(value) ||
    !Number.isSafeInteger(value["pid"]) ||
    Number(value["pid"]) <= 0 ||
    typeof value["startTicks"] !== "string" ||
    !/^\d+$/.test(value["startTicks"]) ||
    typeof value["bootId"] !== "string" ||
    !value["bootId"] ||
    typeof value["executable"] !== "string" ||
    !isAbsolute(value["executable"]) ||
    typeof value["imageDev"] !== "string" ||
    !/^\d+$/.test(value["imageDev"]) ||
    typeof value["imageIno"] !== "string" ||
    !/^\d+$/.test(value["imageIno"])
  )
    throw new Error("monitor process incarnation differs");
  return {
    pid: Number(value["pid"]),
    startTicks: value["startTicks"],
    bootId: value["bootId"],
    executable: value["executable"],
    imageDev: value["imageDev"],
    imageIno: value["imageIno"],
  };
};

/** Explicit operator input only; never discover commands in model transcripts or recover secrets from argv. */
export function readMonitorSet(path: string, sessionId: string, trusted = false): MonitorSet {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error("monitor metadata ownership differs");
  if (trusted && (stat.mode & 0o077) !== 0) throw new Error("trusted monitor bootstrap must be private");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!record(value) || value["version"] !== 1 || value["sessionId"] !== sessionId || !Array.isArray(value["monitors"]))
    throw new Error("monitor metadata session or version differs");
  const names = new Set<string>();
  const monitors: MonitorSpec[] = value["monitors"].map((item: unknown): MonitorSpec => {
    if (
      !record(item) ||
      typeof item["name"] !== "string" ||
      !/^[A-Za-z0-9_.:-]+$/.test(item["name"]) ||
      names.has(item["name"]) ||
      !Array.isArray(item["argv"]) ||
      !item["argv"].length ||
      !item["argv"].every((arg: unknown) => typeof arg === "string" && !arg.includes("\0")) ||
      typeof item["filter"] !== "string" ||
      typeof item["cwd"] !== "string" ||
      !isAbsolute(item["cwd"])
    )
      throw new Error("monitor metadata contains an invalid specification");
    names.add(item["name"]);
    new RegExp(item["filter"]);
    return { name: item["name"], argv: [...item["argv"]] as string[], filter: item["filter"], cwd: item["cwd"] };
  });
  const raw = value["intake"];
  if (
    !record(raw) ||
    typeof raw["path"] !== "string" ||
    !isAbsolute(raw["path"]) ||
    typeof raw["monitor"] !== "string" ||
    !names.has(raw["monitor"]) ||
    typeof raw["maxAgeMs"] !== "number" ||
    !Number.isSafeInteger(raw["maxAgeMs"]) ||
    raw["maxAgeMs"] < 100 ||
    raw["maxAgeMs"] > 600_000
  )
    throw new Error("monitor intake observation is required");
  const intake: IntakeSpec = { path: raw["path"], monitor: raw["monitor"], maxAgeMs: raw["maxAgeMs"] };
  if (monitors.length === 0) throw new Error("deployment needs the desired monitor specifications");
  const observed = value["running"];
  const running: Array<{ name: string; pid: number; identity?: ProcessIdentity }> = [];
  if (observed !== undefined) {
    if (!trusted || !Array.isArray(observed)) throw new Error("monitor process receipts need trusted bootstrap");
    for (const item of observed) {
      if (
        !record(item) ||
        typeof item["name"] !== "string" ||
        !names.has(item["name"]) ||
        typeof item["pid"] !== "number" ||
        !Number.isSafeInteger(item["pid"]) ||
        item["pid"] <= 0 ||
        running.some((entry) => entry.name === item["name"] || entry.pid === item["pid"])
      )
        throw new Error("monitor process receipt differs");
      const identity = item["identity"] === undefined ? undefined : processReceipt(item["identity"]);
      if (identity !== undefined && identity.pid !== item["pid"])
        throw new Error("monitor process incarnation PID differs");
      running.push({ name: item["name"], pid: item["pid"], ...(identity === undefined ? {} : { identity }) });
    }
  }
  const rawRuntime = value["runtime"];
  let runtime: MonitorSet["runtime"];
  if (rawRuntime !== undefined) {
    if (
      !trusted ||
      !record(rawRuntime) ||
      typeof rawRuntime["pane"] !== "string" ||
      rawRuntime["role"] !== "dori" ||
      rawRuntime["sessionId"] !== sessionId ||
      typeof rawRuntime["startedAt"] !== "string" ||
      !Number.isFinite(Date.parse(rawRuntime["startedAt"]))
    )
      throw new Error("monitor runtime incarnation differs");
    runtime = {
      ...processReceipt(rawRuntime),
      pane: rawRuntime["pane"],
      role: "dori",
      sessionId,
      startedAt: rawRuntime["startedAt"],
    };
  }
  return {
    version: 1,
    sessionId,
    monitors,
    intake,
    ...(runtime === undefined ? {} : { runtime }),
    ...(observed === undefined ? {} : { running }),
  };
}

export function sameMonitorSpecs(left: readonly MonitorSpec[], right: readonly MonitorSpec[]): boolean {
  const canonical = (specs: readonly MonitorSpec[]): string =>
    JSON.stringify(
      [...specs]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, argv, filter, cwd }) => ({ name, argv, filter: new RegExp(filter).source, cwd })),
    );
  return canonical(left) === canonical(right);
}

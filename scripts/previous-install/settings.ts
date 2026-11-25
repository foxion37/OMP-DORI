// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadConfig } from "../../skills/cataly-mode/scripts/src/config.ts";
import { convertConfig, isObject, type Json } from "./config.ts";
import type { PreviousHome } from "./homes.ts";
import { entry, ownDirectory, ownFile, ownLink, readText, writeAtomically } from "./paths.ts";

/** The owner's private files a home keeps next to its config: messenger tokens and the owner profile. */
const FILES = ["discord-token", "slack-token", "owner.md", "owner-decisions-archive.md"] as const;
const HISTORY = "owner-history";
/** `omp.yml` keys a side installer manages; every other key is the owner's. */
const MANAGED_YAML: Readonly<Record<string, true>> = { skills: true, update: true };

type Log = (line: string) => void;
type Mode = "primary" | "side";

const parseJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Validate the merged config with the current loader through a private temporary file, then rename it into place. */
export async function publishConfig(path: string, config: Record<string, Json>, home: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.import-${randomUUID()}`);
  writeAtomically(temporary, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  try {
    await loadConfig(temporary, home, { HOME: home });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Copy one private file or link the owner kept; an existing different one in the target wins. */
function importFile(from: string, to: string, log: Log, conflict: string): boolean {
  if (ownLink(from)) {
    if (!entry(to)) symlinkSync(readlinkSync(from), to);
    else if (!ownLink(to) || readlinkSync(to) !== readlinkSync(from)) log(conflict);
    return true;
  }
  if (!ownFile(from)) return false;
  const bytes = readFileSync(from);
  if (!entry(to)) writeAtomically(to, bytes, 0o600);
  else if (!ownFile(to) || !readFileSync(to).equals(bytes)) log(conflict);
  return true;
}

/** Owner keys of an earlier side home's `omp.yml`, added where the target lacks them. */
function importYaml(previous: string, target: string, log: Log): number {
  const from = join(previous, "omp.yml");
  if (!ownFile(from)) return 0;
  const source: unknown = Bun.YAML.parse(readText(from) ?? "");
  const to = join(target, "omp.yml");
  const current: unknown = ownFile(to) ? Bun.YAML.parse(readText(to) ?? "") : {};
  if (!isObject(source) || !isObject(current)) throw new Error("omp.yml is not a YAML mapping");
  let added = 0;
  for (const [key, value] of Object.entries(source)) {
    if (MANAGED_YAML[key]) continue;
    if (!(key in current)) {
      current[key] = value;
      added++;
    } else if (!isDeepStrictEqual(current[key], value))
      log(`Kept your omp.yml ${key} in ${target}; ${previous} had a different value`);
  }
  if (added) writeAtomically(to, Bun.YAML.stringify(current, null, 2), 0o600);
  return added;
}

/**
 * Move an earlier home's settings into the target in the current format. Settings the target already has win; each
 * difference is reported in one line. Returns false when the earlier settings could not be read or validated.
 */
export async function importSettings(previous: PreviousHome, target: string, mode: Mode, home: string, log: Log) {
  const carried: string[] = [];
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const configPath = join(target, "config.json");
    if (ownFile(join(previous.path, "config.json"))) {
      const { config, dropped } = convertConfig(
        parseJson(join(previous.path, "config.json")),
        previous.path,
        target,
        home,
      );
      const existing = entry(configPath) ? parseJson(configPath) : undefined;
      if (existing !== undefined && !isObject(existing)) throw new Error(`${configPath} is not a JSON object`);
      const merged: Record<string, Json> = existing ? { ...existing } : { ...config };
      if (!existing && mode === "side") merged["stateDir"] = join(target, "state");
      let count = existing ? 0 : Object.keys(config).length;
      for (const [key, value] of existing ? Object.entries(config) : []) {
        if (!(key in merged)) {
          merged[key] = value;
          count++;
        } else if (!isDeepStrictEqual(merged[key], value) && key !== "agentCommand")
          log(`Kept your ${key} setting in ${configPath}; ${previous.path} had a different value`);
      }
      if (!isDeepStrictEqual(merged, existing)) await publishConfig(configPath, merged, home);
      const left = dropped.length ? `; left behind ${dropped.join(", ")}` : "";
      carried.push(`config.json (${count} settings${left})`);
    }
    for (const name of FILES) {
      const conflict = `Kept your ${name} in ${target}; ${previous.path} had a different one`;
      if (importFile(join(previous.path, name), join(target, name), log, conflict)) carried.push(name);
    }
    const history = join(previous.path, HISTORY);
    if (ownDirectory(history)) {
      mkdirSync(join(target, HISTORY), { recursive: true, mode: 0o700 });
      for (const name of readdirSync(history))
        importFile(join(history, name), join(target, HISTORY, name), log, `Kept your ${HISTORY}/${name} in ${target}`);
      carried.push(`${HISTORY}/`);
    }
    if (mode === "side" && previous.mode === "side" && importYaml(previous.path, target, log)) carried.push("omp.yml");
  } catch (error) {
    log(`Kept ${previous.path}: its settings could not be imported (${(error as Error).message})`);
    return false;
  }
  log(`Imported settings from ${previous.path} into ${target}: ${carried.join(", ") || "none to import"}`);
  return true;
}

/** Whether every setting the earlier home holds is present in the target and the target config loads. */
export async function verifyImport(previous: PreviousHome, target: string, home: string): Promise<string | undefined> {
  try {
    const configPath = join(target, "config.json");
    if (ownFile(join(previous.path, "config.json"))) {
      const { config } = convertConfig(parseJson(join(previous.path, "config.json")), previous.path, target, home);
      const current = parseJson(configPath);
      if (!isObject(current)) return `${configPath} is not a JSON object`;
      const missing = Object.keys(config).filter((key) => !(key in current));
      if (missing.length) return `${configPath} lacks ${missing.join(", ")}`;
      await loadConfig(configPath, home, { HOME: home });
    }
    const files: string[] = FILES.filter((name) => entry(join(previous.path, name)));
    if (ownDirectory(join(previous.path, HISTORY)))
      files.push(...readdirSync(join(previous.path, HISTORY)).map((name) => join(HISTORY, name)));
    const absent = files.filter((name) => !entry(join(target, name)));
    return absent.length ? `${target} lacks ${absent.join(", ")}` : undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

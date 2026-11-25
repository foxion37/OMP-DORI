// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { realpathSync } from "node:fs";
import { relative } from "node:path";

/** The removed ULW launch prefix and the default launch keywords that replaced it. */
const ULW_KEYWORD = /^ulw\s+/;
const DEFAULT_KEYWORDS = "set goal and work";
/** The removed terminal runtimes. */
const REMOVED_RUNTIMES: Readonly<Record<string, true>> = { herdr: true, hc: true };
/** Pane settings of a removed runtime name its panes, which no longer exist. */
const PANE_KEYS = ["leadPane", "laneWorkspace", "workspaces", "ignorePanes"];
const COMMANDS: Readonly<Record<string, string>> = {
  dori: "cataly",
  "dori-harness": "cataly-harness",
  "omp-dori": "omp-cataly",
  "--dori-role": "--cataly-role",
};

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const isObject = (value: unknown): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const underHome = (path: string, home: string): string | undefined => {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? `~/${rel}` : undefined;
};

/** The spellings of a home in a setting, longest first: absolute, physical, and `~/` relative under HOME. */
function spellings(path: string, home: string): string[] {
  const forms = new Set([path]);
  try {
    forms.add(realpathSync(path));
  } catch {
    // A home that is already gone keeps its written spelling.
  }
  const tilde = underHome(path, home);
  if (tilde) forms.add(tilde);
  return [...forms].sort((a, b) => b.length - a.length);
}

type Move = { readonly from: readonly string[]; readonly absolute: string; readonly tilde: string | undefined };

/** One setting string in the current spelling: paths into the earlier home move to the target home, and omp-dori
 * command, skill, flag and environment names become their Cataly names. */
function convertText(text: string, move: Move): string {
  let out = COMMANDS[text] ?? text;
  for (const form of move.from) {
    const into = form.startsWith("~/") ? (move.tilde ?? move.absolute) : move.absolute;
    out = out === form ? into : out.split(`${form}/`).join(`${into}/`);
  }
  return out
    .replaceAll("/skills/dori-mode/", "/skills/cataly-mode/")
    .replace(/\/bin\/dori-harness(?=$|["'\s/])/g, "/bin/cataly-harness")
    .replace(/\/bin\/omp-dori(?=$|["'\s/])/g, "/bin/omp-cataly")
    .replace(/\/bin\/dori(?=$|["'\s/])/g, "/bin/cataly")
    .replace(/--dori-role\b/g, "--cataly-role")
    .replace(/\bOMP_DORI_(?=[A-Z0-9_])/g, "OMP_CATALY_")
    .replace(/\bDORI_(?=[A-Z0-9_])/g, "CATALY_");
}

/**
 * A config.json of an earlier installation in the current format, and the names of settings that were not carried
 * over: `dori` keys, `ompUlwPath`, the herdr/hc runtimes and their panes, and the removed `ulw ` launch prefix. Every
 * other setting is kept as written, so a value that is invalid for other reasons still fails ordinary validation. An
 * import also leaves the old `stateDir` behind (old state is not imported); a conversion in place
 * (`previous === target`) keeps it.
 */
export function convertConfig(
  raw: unknown,
  previous: string,
  target: string,
  home: string,
): { readonly config: Record<string, Json>; readonly dropped: readonly string[] } {
  if (!isObject(raw)) throw new Error("config.json is not a JSON object");
  const dropped: string[] = [];
  const move: Move = { from: spellings(previous, home), absolute: target, tilde: underHome(target, home) };
  const walk = (value: Json, path: string): Json => {
    if (typeof value === "string") return convertText(value, move);
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`));
    if (!isObject(value)) return value;
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      const name = path ? `${path}.${key}` : key;
      if (/dori/i.test(key)) dropped.push(name);
      else out[key] = walk(child, name);
    }
    return out;
  };
  const config = walk(raw, "") as Record<string, Json>;
  const drop = (key: string): void => {
    if (!(key in config)) return;
    delete config[key];
    dropped.push(key);
  };
  const removed = (key: string) => typeof config[key] === "string" && REMOVED_RUNTIMES[config[key]] === true;
  if (removed("runtime")) {
    drop("runtime");
    for (const key of PANE_KEYS) drop(key);
  }
  if (removed("sessionRuntime")) drop("sessionRuntime");
  drop("ompUlwPath");
  // The installer writes its own agent command: one that ran a generated wrapper inside the earlier home is that
  // home's, and an imported tilde path would never spawn. A conversion in place keeps the home's own command.
  const agent = isObject(raw) && Array.isArray(raw["agentCommand"]) ? raw["agentCommand"][0] : undefined;
  if (previous !== target && typeof agent === "string" && move.from.some((form) => agent.startsWith(`${form}/`)))
    drop("agentCommand");
  if (previous !== target) drop("stateDir");
  const keywords = config["launchKeywords"];
  if (typeof keywords === "string" && ULW_KEYWORD.test(keywords)) {
    const plain = keywords.replace(ULW_KEYWORD, "");
    if (plain === DEFAULT_KEYWORDS) drop("launchKeywords");
    else {
      config["launchKeywords"] = plain;
      dropped.push("launchKeywords ulw prefix");
    }
  }
  return { config, dropped };
}

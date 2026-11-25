// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { convertConfig, isObject } from "./config.ts";
import { modeMarker } from "./homes.ts";
import { inside, linkTarget, ownDirectory, ownFile, ownLink, readText } from "./paths.ts";
import { generatedWrapper, removeEntry, ulwClone } from "./retire.ts";
import { inUse } from "./running.ts";
import { publishConfig } from "./settings.ts";

type Log = (line: string) => void;

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readText(path) ?? "");
  } catch {
    return undefined;
  }
};

/** Convert the target's own config.json in place; a result the current loader rejects is left as written. */
async function convertTargetConfig(target: string, home: string, log: Log): Promise<void> {
  const path = join(target, "config.json");
  if (!ownFile(path)) return;
  const raw = readJson(path);
  if (!isObject(raw)) return;
  const { config, dropped } = convertConfig(raw, target, target, home);
  if (isDeepStrictEqual(config, raw)) return;
  try {
    await publishConfig(path, config, home);
    log(`Converted ${path} to the current format; left behind ${dropped.join(", ") || "no settings"}`);
  } catch (error) {
    log(`Kept ${path} as written: its converted settings do not load (${(error as Error).message})`);
  }
}

/** A side skill copy an omp-dori side installer generated: its SKILL.md is named omp-dori-mode. */
const generatedSkill = (path: string): boolean =>
  ownDirectory(path) && (readText(join(path, "SKILL.md")) ?? "").startsWith("---\nname: omp-dori-mode\n");

/** Entries earlier installers wrote inside the home that this version no longer has. */
function removeHomeLeftovers(target: string, log: Log): void {
  const at = (name: string) => join(target, name);
  if (ownLink(at("omp-ulw")) || ulwClone(at("omp-ulw"))) removeEntry(at("omp-ulw"), "the omp-ulw overlay link", log);
  if (ulwClone(at("omp-ulw-custom"))) removeEntry(at("omp-ulw-custom"), "the omp-ulw checkout", log);
  for (const name of [".omp-cataly-ulw", ".omp-dori-ulw"])
    if (ownLink(at(name))) removeEntry(at(name), "the omp-ulw checkout choice", log);
  if (modeMarker(target, ".omp-dori")) removeEntry(at(".omp-dori"), "the omp-dori installation marker", log);
  for (const name of ["bin/dori", "bin/dori-harness", "bin/omp-dori"])
    if (ownLink(at(name)) || generatedWrapper(at(name))) removeEntry(at(name), "the omp-dori command", log);
  // A command link an earlier installer left on an omp-dori path this version no longer writes.
  for (const name of ["bin/cataly", "bin/cataly-harness", "bin/omp-cataly"])
    if (ownLink(at(name)) && /\/(?:skills\/dori-mode\/|bin\/omp-dori$)/.test(readlinkSync(at(name))))
      removeEntry(at(name), "the omp-dori command", log);
  if (generatedSkill(at("skills/omp-dori-mode"))) removeEntry(at("skills/omp-dori-mode"), "the omp-dori skill", log);
}

/** Whether a consumer store record names a release in the omp-dori format (manifest version 1). */
const previousFormat = (value: unknown): boolean =>
  isObject(value) &&
  [value["current"], value["previous"], value["target"], value["manifest"]].some(
    (manifest) => isObject(manifest) && (manifest["version"] === 1 || manifest["product"] === "omp-dori"),
  );

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Remove a release store of the omp-dori format, which this version cannot read, so the installer sets up the current
 * one: the releases and their records (the automatic-update choice stays), the source and native pointers into them,
 * and the side wrappers whose bytes are still the ones the store recorded.
 */
function removePreviousStore(target: string, log: Log): void {
  const root = join(target, "releases");
  if (!ownDirectory(root)) return;
  const records = ["consumer-installed.json", "consumer-journal.json"].map((name) => readJson(join(root, name)));
  if (!records.some(previousFormat)) return;
  const held = inUse([root]);
  if (held) {
    log(`Kept the previous release store ${root}: ${held}; the next install retries`);
    return;
  }
  const references = readJson(join(root, "consumer-references.json"));
  if (isObject(references))
    for (const [name, digest] of Object.entries(references)) {
      const path = join(target, name);
      if (/^(?:bin\/[a-z-]+|omp\.yml)$/.test(name) && ownFile(path) && sha256(path) === digest)
        removeEntry(path, "the previous release's generated file", log);
    }
  for (const name of ["src", "bin/cataly", "bin/cataly-harness", "bin/omp", "bin/omp-cataly"]) {
    const path = join(target, name);
    const to = ownLink(path) ? linkTarget(path) : undefined;
    if (to && inside(to, root)) removeEntry(path, "the previous release pointer", log);
  }
  for (const name of readdirSync(root))
    if (name !== "consumer-automatic.json") removeEntry(join(root, name), "the previous release store entry", log);
}

/**
 * Bring a target home an earlier version wrote to the current format in place: its config, the entries this version
 * no longer writes, and a release store it cannot read.
 */
export async function convertTarget(target: string, home: string, log: Log): Promise<void> {
  if (!ownDirectory(target)) return;
  await convertTargetConfig(target, home, log);
  removeHomeLeftovers(target, log);
  removePreviousStore(target, log);
}

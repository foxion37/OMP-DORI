// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { join, resolve } from "node:path";
import { isObject } from "./config.ts";
import { inside, ownDirectory, ownFile, ourTree, readText } from "./paths.ts";

/** An earlier installation's home, and what proves an earlier Cataly or omp-dori wrote it. */
export type PreviousHome = { readonly path: string; readonly mode: "primary" | "side"; readonly evidence: string };

/** The mode marker earlier source installers wrote into their home: exactly `primary` or `side` and a newline. */
export function modeMarker(home: string, name: ".omp-dori" | ".omp-cataly"): "primary" | "side" | undefined {
  const path = join(home, name);
  if (!ownFile(path)) return undefined;
  const text = readText(path);
  return text === "primary\n" ? "primary" : text === "side\n" ? "side" : undefined;
}

/** A release home's ownership receipt names this home's own `src` as its live source. */
function releaseHome(home: string): boolean {
  const path = join(home, "releases/consumer-owner.json");
  if (!ownFile(path)) return false;
  try {
    const owner: unknown = JSON.parse(readText(path) ?? "");
    return isObject(owner) && owner["version"] === 1 && owner["liveSource"] === join(home, "src");
  } catch {
    return false;
  }
}

/** Why `home` is an earlier Cataly or omp-dori installation; undefined when nothing proves it (never its name alone). */
export function previousEvidence(home: string): string | undefined {
  if (!ownDirectory(home)) return undefined;
  for (const name of [".omp-dori", ".omp-cataly"] as const)
    if (modeMarker(home, name)) return `its ${name} installation marker`;
  if (releaseHome(home)) return "its release installation receipt";
  if (ourTree(join(home, "src"))) return "its omp-dori source checkout";
  return undefined;
}

/**
 * Earlier homes, same mode as the target first: the omp-dori primary (`~/.dori`, or `DORI_HOME`) and side
 * (`~/.omp-dori`, or `OMP_DORI_HOME`) locations. The target itself and homes nested with it are never sources.
 */
export function previousHomes(
  target: string,
  mode: "primary" | "side",
  env: Readonly<Record<string, string | undefined>>,
): PreviousHome[] {
  const home = resolve(env["HOME"] ?? "/");
  const selected = (value: string | undefined) => (value?.startsWith("/") ? resolve(value) : undefined);
  const candidates: [string | undefined, "primary" | "side"][] = [
    [join(home, ".dori"), "primary"],
    [selected(env["DORI_HOME"]), "primary"],
    [join(home, ".omp-dori"), "side"],
    [selected(env["OMP_DORI_HOME"]), "side"],
  ];
  const found = new Map<string, PreviousHome>();
  for (const [path, kind] of candidates) {
    if (!path || found.has(path) || inside(path, target) || inside(target, path)) continue;
    const evidence = previousEvidence(path);
    if (evidence) found.set(path, { path, mode: modeMarker(path, ".omp-dori") ?? kind, evidence });
  }
  return [...found.values()].sort((a, b) => Number(a.mode !== mode) - Number(b.mode !== mode));
}

// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isUlwCheckout } from "../../src/update/ulw-fixture.ts";
import { isObject } from "./config.ts";
import type { PreviousHome } from "./homes.ts";
import { inUse } from "./running.ts";
import { entry, inside, ourTree, ownDirectory, ownFile, ownLink, readText, removeTree } from "./paths.ts";

type Log = (line: string) => void;

/**
 * Top-level entries the earlier installers, releases and harness wrote into their home. Anything else in an earlier
 * home is the owner's own and is kept, with the home.
 */
const KNOWN: Readonly<Record<string, true>> = {
  ".omp-dori": true,
  ".omp-cataly": true,
  ".omp-dori-ulw": true,
  ".omp-cataly-ulw": true,
  ".DS_Store": true,
  src: true,
  "omp-ulw": true,
  "omp-ulw-custom": true,
  bin: true,
  skills: true,
  "env.sh": true,
  "omp.yml": true,
  backups: true,
  releases: true,
  "config.json": true,
  "discord-token": true,
  "slack-token": true,
  "owner.md": true,
  "owner-history": true,
  "owner-decisions-archive.md": true,
  state: true,
  "roles.json": true,
  "harness-native.json": true,
  "harness-lead.json": true,
  "harness.lock": true,
  "controller.lock": true,
  duty: true,
  loop: true,
  inbox: true,
  backlog: true,
  lanes: true,
  briefs: true,
  receipts: true,
  prompts: true,
};
/** What the installers generated inside a home's `bin` and `skills`; anything else there is the owner's. */
const GENERATED: Readonly<Record<string, readonly string[]>> = {
  bin: ["cataly", "cataly-harness", "cataly-native", "omp", "omp-cataly", "dori", "dori-harness", "omp-dori"],
  skills: ["omp-cataly-mode", "omp-dori-mode"],
};

/** A checkout holds no owner work: nothing uncommitted or untracked, and every commit is on a remote branch. */
function cleanCheckout(dir: string): boolean {
  const git = (...argv: string[]) =>
    Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...argv], {
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? dir, GIT_OPTIONAL_LOCKS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
  const status = git("status", "--porcelain=v1", "--untracked-files=normal");
  const local = git("rev-list", "--count", "HEAD", "--not", "--remotes");
  return status.exitCode === 0 && status.stdout.toString() === "" && local.stdout.toString().trim() === "0";
}

/** A clean omp-ulw checkout an earlier installer cloned; any other directory under that name is the owner's. */
export const ulwClone = (path: string): boolean => isUlwCheckout(path) && cleanCheckout(path);

/** Why one entry of an earlier home is not ours to remove, or undefined when it is. */
function foreign(home: string, name: string): string | undefined {
  const path = join(home, name);
  const directory = ownDirectory(path);
  if (!KNOWN[name] || !(directory || ownLink(path) || ownFile(path))) return `${name} is not Cataly's`;
  if (!directory) return undefined;
  if (name === "omp-ulw" || name === "omp-ulw-custom")
    return ulwClone(path) ? undefined : `${name} is not a clean omp-ulw checkout`;
  if (name === "src" && entry(join(path, ".git")))
    return ourTree(path) && cleanCheckout(path) ? undefined : "its source checkout src has local changes";
  const generated = GENERATED[name];
  const added = generated && readdirSync(path).find((child) => !generated.includes(child));
  return added ? `${name}/${added} is not Cataly's` : undefined;
}

/** The state directories an earlier home's config names, in addition to its own `state`. */
function stateDirs(home: string): string[] {
  const dirs = [join(home, "state")];
  try {
    const config: unknown = JSON.parse(readText(join(home, "config.json")) ?? "{}");
    const value = isObject(config) ? config["stateDir"] : undefined;
    if (typeof value === "string" && value.startsWith("~/"))
      dirs.push(join(process.env["HOME"] ?? "/", value.slice(2)));
    else if (typeof value === "string" && value.startsWith("/")) dirs.push(value);
  } catch {
    // An unreadable config names no other state directory.
  }
  return dirs;
}

/** Why an earlier home must stay for now, or undefined when nothing of it runs and nothing installed uses it. */
export function homeHeld(home: string, protect: readonly string[]): string | undefined {
  const used = protect.find((path) => inside(path, home));
  if (used) return `it holds ${used}, which this installation uses`;
  return inUse([home], { stateDirs: stateDirs(home), ompDori: true });
}

/**
 * Remove an earlier home whose settings the target holds. Entries the owner added stay, and so does a checkout of ours
 * with owner work, with everything around it. Returns whether the earlier home is gone.
 */
export function retireHome(previous: PreviousHome, held: string | undefined, log: Log): boolean {
  const home = previous.path;
  if (held) {
    log(`Kept ${home}: ${held}; the next install retries`);
    return false;
  }
  const reasons = readdirSync(home).map((name) => [name, foreign(home, name)] as const);
  const blocking = reasons.find(([name, reason]) => reason && (name === "src" || name.startsWith("omp-ulw")));
  if (blocking) {
    log(`Kept ${home}: ${blocking[1]}`);
    return false;
  }
  const kept: string[] = [];
  for (const [name, reason] of reasons) {
    if (reason) kept.push(name);
    else
      try {
        removeTree(join(home, name));
      } catch (error) {
        kept.push(`${name} (${(error as Error).message})`);
      }
  }
  if (kept.length) {
    log(`Removed the previous installation's files from ${home}; kept ${kept.join(", ")}, which Cataly did not write`);
    return false;
  }
  rmdirSync(home);
  log(`Removed the previous installation ${home}`);
  return true;
}

/** Remove one file, link or directory of ours, logging it in one line. */
export function removeEntry(path: string, what: string, log: Log): void {
  if (entry(path)?.isDirectory()) removeTree(path);
  else rmSync(path, { force: true });
  log(`Removed ${what} ${path}`);
}

/** Our generated shell wrapper: a small Bash script that only sets up and execs a Cataly or omp-dori command. */
export function generatedWrapper(path: string): boolean {
  if (!ownFile(path) || (entry(path)?.size ?? 0) > 8192) return false;
  const text = readFileSync(path, "utf8");
  return text.startsWith("#!/usr/bin/env bash\n") && /\nexec /.test(text) && /cataly|dori/.test(text);
}

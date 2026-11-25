#!/usr/bin/env bun
/*
 * ONE-WAY BRIDGE FROM PREVIOUS INSTALLATIONS. This directory is the only code that reads what omp-dori and earlier
 * Cataly versions left behind. Only the installers (install.sh and scripts/install-source.sh) run it, as this
 * command; the product never imports it.
 *
 *   import --home TARGET --mode primary|side
 *     Before the installer reads its configuration: bring TARGET, if an earlier version wrote it, to the current format
 *     in place, then import the config, messenger tokens and owner profile of every earlier home of the same mode
 *     (`~/.dori`, `~/.omp-dori`, `DORI_HOME`, `OMP_DORI_HOME`, each proven ours by its markers) into TARGET, converted
 *     and validated with the current loader. TARGET's own settings always win.
 *   retire --home TARGET --mode primary|side --source SOURCE
 *     After a successful install: remove the links and caches earlier installs made, delete each earlier home whose
 *     import verifies and of which nothing runs (otherwise keep it; the next install retries), and hand a managed
 *     deployment still on the previous main's controller to the controller in SOURCE.
 *
 * Every removal and every kept leftover is reported in one line. A second run finds nothing to do.
 */
import { parseArgs } from "node:util";
import { previousHomes } from "./homes.ts";
import { removeCaches, removeGlobalLinks, type Scope } from "./leftovers.ts";
import { places } from "./paths.ts";
import { homeHeld, retireHome } from "./retire.ts";
import { importSettings, verifyImport } from "./settings.ts";
import { handOverDeployments } from "./supervisor.ts";
import { convertTarget } from "./target.ts";

const log = (line: string): void => console.error(line);
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: { home: { type: "string" }, mode: { type: "string" }, source: { type: "string" } },
});
const phase = positionals[0];
const target = values.home;
const mode = values.mode;
if (
  positionals.length !== 1 ||
  (phase !== "import" && phase !== "retire") ||
  !target?.startsWith("/") ||
  (mode !== "primary" && mode !== "side") ||
  (phase === "retire" && !values.source?.startsWith("/"))
) {
  log("Usage: previous-install/cli.ts import|retire --home TARGET --mode primary|side [--source SOURCE]");
  process.exit(2);
}
const env = process.env;
const where = places(env);
const homes = previousHomes(target, mode, env).filter((home) => home.mode === mode);

if (phase === "import") {
  await convertTarget(target, where.home, log);
  for (const home of homes) await importSettings(home, target, mode, where.home, log);
} else {
  const source = values.source!;
  const protect = [source, process.cwd()];
  const held = new Map(homes.map((home) => [home.path, homeHeld(home.path, protect)] as const));
  for (const home of homes) {
    if (held.get(home.path)) continue;
    const unverified = await verifyImport(home, target, where.home);
    if (unverified) held.set(home.path, `its import into ${target} is not verified (${unverified})`);
  }
  // Every earlier home stays unless this install retires it: one of the other mode, or one kept for now.
  const all = previousHomes(target, mode, env);
  const retiring = new Set(homes.filter((home) => !held.get(home.path)).map((home) => home.path));
  const scope: Scope = {
    places: where,
    env,
    target,
    homes: all,
    held: new Set(all.map((home) => home.path).filter((path) => !retiring.has(path))),
  };
  removeGlobalLinks(scope, log);
  for (const home of homes) retireHome(home, held.get(home.path), log);
  handOverDeployments(source, where.home, log);
  removeCaches(scope, log);
}

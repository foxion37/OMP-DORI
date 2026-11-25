// One-way bridge from previous installations (see cli.ts). Only the installers run it; the product never imports it.
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PreviousHome } from "./homes.ts";
import { inside, linkTarget, ownDirectory, ownLink, type Places, treeOf } from "./paths.ts";
import { removeEntry } from "./retire.ts";
import { inUse } from "./running.ts";

type Log = (line: string) => void;
type Env = Readonly<Record<string, string | undefined>>;

/** What the leftovers are judged against: every earlier home, and those of them that this install keeps. */
export type Scope = {
  readonly places: Places;
  readonly env: Env;
  readonly target: string;
  readonly homes: readonly PreviousHome[];
  readonly held: ReadonlySet<string>;
};

/** The final target of a link chain, or undefined when it is dangling. */
const physical = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
const insideHome = (path: string | undefined, homes: readonly PreviousHome[]) =>
  path !== undefined && homes.some((home) => inside(path, home.path));
const insideHeld = (path: string | undefined, scope: Scope) =>
  path !== undefined && [...scope.held].some((home) => inside(path, home));

/** The omp-dori extension: a link into one of our trees or an earlier home; dangling, its name alone is ours. */
function extensionLink(link: string, scope: Scope): boolean {
  const to = physical(link);
  return to === undefined || treeOf(to, "/extension") !== undefined || insideHome(to, scope.homes);
}

/** The omp-ulw extension: a link to exactly the checkout an earlier installer kept in its home. */
function ulwLink(link: string, scope: Scope): boolean {
  const homes = [
    join(scope.places.home, ".dori"),
    join(scope.places.home, ".cataly"),
    scope.target,
    scope.env["DORI_HOME"],
    ...scope.homes.map((home) => home.path),
  ];
  const to = resolve(dirname(link), readlinkSync(link));
  return homes.some((home) => home && [join(home, "omp-ulw"), join(home, "omp-ulw-custom")].includes(to));
}

/** The omp-dori side command: a link to an earlier side home's `bin/omp-dori`. */
function sideCommand(link: string, scope: Scope): boolean {
  const to = linkTarget(link);
  const sides = [join(scope.places.home, ".omp-dori"), scope.env["OMP_DORI_HOME"], ...scope.homes.map((h) => h.path)];
  return sides.some((home) => home && to === join(home, "bin/omp-dori"));
}

/** The command an omp-dori `dori` or `dori-harness` link ran: our tree's skill CLI or harness CLI. */
function commandLink(name: string): (link: string, scope: Scope) => boolean {
  const suffixes =
    name === "dori-harness"
      ? ["/src/cli.ts"]
      : ["/skills/dori-mode/scripts/src/cli.ts", "/skills/cataly-mode/scripts/src/cli.ts"];
  return (link, scope) => {
    const to = physical(link);
    return suffixes.some((suffix) => treeOf(to, suffix) !== undefined) || insideHome(to, scope.homes);
  };
}

/**
 * Each global entry an earlier install made, and how to prove one is ours. OMP discovers extensions and skills in
 * every new session, so those links go even while an earlier home still runs; a command into a home still in use
 * stays with that home.
 */
const GLOBAL: readonly {
  readonly where: "extensions" | "skills" | "bins" | "bunGlobal";
  readonly name: string;
  readonly what: string;
  readonly discovered: boolean;
  readonly ours: (link: string, scope: Scope) => boolean;
}[] = [
  {
    where: "extensions",
    name: "omp-dori",
    what: "the omp-dori OMP extension link",
    discovered: true,
    ours: extensionLink,
  },
  { where: "extensions", name: "omp-ulw", what: "the omp-ulw OMP extension link", discovered: true, ours: ulwLink },
  {
    where: "skills",
    name: "dori-mode",
    what: "the dori-mode skill link",
    discovered: true,
    ours: (link, scope) =>
      treeOf(physical(link), "/skills/dori-mode") !== undefined || insideHome(physical(link), scope.homes),
  },
  { where: "bins", name: "dori", what: "the omp-dori command link", discovered: false, ours: commandLink("dori") },
  {
    where: "bins",
    name: "dori-harness",
    what: "the omp-dori command link",
    discovered: false,
    ours: commandLink("dori-harness"),
  },
  { where: "bins", name: "omp-dori", what: "the omp-dori command link", discovered: false, ours: sideCommand },
  {
    where: "bunGlobal",
    name: "dori-mode-scripts",
    what: "the omp-dori Bun link",
    discovered: false,
    ours: (link) => treeOf(physical(link), "/skills/dori-mode/scripts") !== undefined,
  },
  {
    where: "bunGlobal",
    name: "dori-superagent",
    what: "the omp-dori Bun link",
    discovered: false,
    ours: (link) => treeOf(physical(link), "") !== undefined,
  },
];

/** Remove the links earlier installs made outside their home. */
export function removeGlobalLinks(scope: Scope, log: Log): void {
  for (const kind of GLOBAL) {
    const dirs = scope.places[kind.where];
    for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
      const link = join(dir, kind.name);
      if (!ownLink(link) || !kind.ours(link, scope)) continue;
      if (kind.discovered || (!insideHeld(linkTarget(link), scope) && !insideHeld(physical(link), scope)))
        removeEntry(link, kind.what, log);
    }
  }
}

/** Caches earlier versions prepared: omp-dori's native cache root and the omp-ulw overlay checkouts. */
export function removeCaches(scope: Scope, log: Log): void {
  const caches = scope.places.caches;
  const ulwRoot = join(caches, "omp-cataly");
  const candidates = [
    join(caches, "omp-dori"),
    ...(ownDirectory(ulwRoot) ? readdirSync(ulwRoot) : [])
      .filter((name) => /^omp-ulw-[a-f0-9]{64}(?:\.preparing)?$/.test(name))
      .map((name) => join(ulwRoot, name)),
  ];
  for (const path of candidates) {
    if (!ownDirectory(path)) continue;
    const held = inUse([path], { stateDirs: [] });
    if (held) log(`Kept ${path}: ${held}; the next install retries`);
    else removeEntry(path, "the previous version's cache", log);
  }
}

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { consumerPaths, owned, realDirectory, regularFile } from "./files.ts";

/** Managed cache paths follow this loaded release's lock without changing the user's config. */
export function resolveConsumerOmpUlwPath(
  configuredPath: string,
  {
    home = homedir(),
    sourceRoot = resolve(import.meta.dir, "../.."),
  }: {
    readonly home?: string;
    readonly sourceRoot?: string;
  } = {},
): string {
  const paths = consumerPaths(home);
  const entry = relative(paths.dependencies, configuredPath);
  if (configuredPath !== join(paths.dependencies, entry) || !/^omp-ulw-[a-f0-9]{40}(?:\/index\.ts)?$/.test(entry))
    return configuredPath;

  // Resolve the helper's physical location at call time, never the mutable ~/.dori/src pointer.
  const source = realpathSync(sourceRoot);
  if (dirname(source) !== paths.releases || !/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(basename(source)))
    return configuredPath;
  owned(source);
  const lock = join(source, "omp-ulw.lock");
  if (!regularFile(lock)) throw new Error(`Missing consumer release lock: ${lock}`);
  const commit = readFileSync(lock, "utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid consumer release lock: ${lock}`);

  const dependency = join(paths.dependencies, `omp-ulw-${commit}`);
  realDirectory(dependency);
  owned(dependency);
  if (!regularFile(join(dependency, "index.ts"))) throw new Error(`Missing consumer dependency entry: ${dependency}`);
  return entry.endsWith("/index.ts") ? join(dependency, "index.ts") : dependency;
}

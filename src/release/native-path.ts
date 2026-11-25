import { lstatSync, realpathSync } from "node:fs";
import { platform } from "../platform/index.ts";
import { leaseNativeIdentity, nativeCacheRoot } from "./native-cache-lease.ts";

/**
 * Lease the identity an explicitly chosen executable lies in (by its own path or once resolved), so a writer that
 * publishes it (a wrapper, a deployment record) holds it like one that prepared it. Then the executable must still be
 * there: a prune may have removed it before the lease. Paths outside the cache lease nothing.
 */
export function leaseNativePath(home: string, path: string, holder = process.pid): void {
  const entry = new RegExp(`^${platform.nativeCacheLabel()}-([a-f0-9]{64})$`);
  const inside = (candidate: string, root: string) =>
    candidate.startsWith(`${root}/`) ? entry.exec(candidate.slice(root.length + 1).split("/", 1)[0]!)?.[1] : undefined;
  const real = (candidate: string) => {
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  };
  const physical = real(path);
  const cache = nativeCacheRoot(home);
  const identity = inside(path, cache) ?? inside(physical, cache) ?? inside(physical, real(cache));
  if (!identity) return;
  leaseNativeIdentity(home, identity, holder);
  if (!lstatSync(physical, { throwIfNoEntry: false })?.isFile())
    throw new Error(`Selected native executable ${path} is gone from the native cache; prepare it again`);
}

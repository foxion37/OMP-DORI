import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsumerPaths } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { fixture } from "./release-consumer-setup.ts";

export function snapshot(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return "absent";
  if (stat.isSymbolicLink()) return JSON.stringify({ mode: stat.mode, target: readlinkSync(path) });
  if (stat.isDirectory()) {
    return JSON.stringify({
      mode: stat.mode,
      entries: readdirSync(path)
        .sort()
        .map((name) => [name, snapshot(join(path, name))]),
    });
  }
  return JSON.stringify({ mode: stat.mode, bytes: readFileSync(path).toString("base64") });
}

export const protectedSnapshot = (paths: ConsumerPaths) => [
  snapshot(paths.dori),
  ...paths.links.map(([path]) => snapshot(path)),
];
export const consumerEnv = (paths: ConsumerPaths) => ({
  HOME: paths.home,
  SKILLS_DIR: join(paths.home, ".agents/skills"),
  OMP_EXTENSIONS_DIR: join(paths.home, ".omp/agent/extensions"),
  OMP_DORI_HOME: join(paths.home, ".omp-dori"),
  OMP_DORI_BIN_DIR: join(paths.home, "global-bin"),
});

export async function installedConsumer() {
  const f = fixture();
  await installBundle(f.paths, f.release("consumer source stays frozen").bundle, undefined);
  // A stale source marker must not override consumer ownership or the consumer extension link.
  writeFileSync(join(f.paths.dori, ".omp-dori"), "primary\n");
  return f;
}

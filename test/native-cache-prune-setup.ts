import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeReceipt } from "../src/release/native.ts";
import {
  type NativeCachePrune,
  type NativeCachePruneOptions,
  pruneNativeCache,
} from "../src/release/native-cache-prune.ts";
import { nativeCacheFixture, overlayFixture, ownProcessCwds, ownProcessFiles } from "./source-bundle-setup.ts";

const roots: string[] = [];

/** Remove every fixture made since the last call (register it with `afterEach`). */
export function removePruneFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A subprocess readiness line can be split across multiple pipe chunks. */
export function processLineReader(stdout: ReadableStream<Uint8Array>): () => Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return async () => {
    for (;;) {
      const end = pending.indexOf("\n");
      if (end !== -1) {
        const line = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        return line;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("Subprocess exited before writing a complete readiness line");
      pending += decoder.decode(value, { stream: true });
    }
  };
}

export type PruneFixture = {
  readonly root: string;
  readonly home: string;
  readonly refs: string;
  readonly native: (name: string, keepSource?: boolean) => NativeReceipt;
  readonly wrapper: (omp: string) => string;
  readonly prune: (options?: NativeCachePruneOptions, more?: readonly string[]) => NativeCachePrune;
};

/**
 * A home with one reference root. Each identity's bound text names this fixture's directory, so identities differ
 * between fixtures and tests running at the same time cannot see each other's processes as users. An identity's own
 * source is removed unless kept, so only what a test adds uses it.
 * `prune` has no grace period unless a test sets one, so a second prune asked to remove (`deleteQuarantined`) removes
 * what the first quarantined. It sees
 * only the fixture's processes: the host's unreadable or privileged processes and its Cataly writers (other
 * lanes' launches) stay out unless a test passes its own reader or process table.
 */
export function pruneFixture(files = ownProcessFiles): PruneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-native-prune-")));
  roots.push(root);
  const home = join(root, "home");
  const refs = join(root, "refs");
  mkdirSync(refs);
  const native = (name: string, keepSource = false) => {
    const f = overlayFixture(join(root, `source-${name}`), join(root, `upstream-${name}`), `${name} ${root}`);
    const receipt = nativeCacheFixture(f.source, home, f.checkout);
    if (!keepSource) rmSync(f.source, { recursive: true });
    return receipt;
  };
  const wrapper = (omp: string) => `#!/bin/sh\nexec ${JSON.stringify(omp)} "$@"\n`;
  const prune = (options: NativeCachePruneOptions = {}, more: readonly string[] = []): NativeCachePrune =>
    pruneNativeCache(home, [], [refs, ...more], {
      readCwds: ownProcessCwds,
      files,
      table: () => "",
      graceMs: 0,
      ...options,
    });
  return { root, home, refs, native, wrapper, prune };
}

/** Why a prune kept `directory`, or undefined when it did not keep it. */
export const keptFor = (result: NativeCachePrune, directory: string): readonly string[] | undefined =>
  result.kept.find((entry) => entry.directory === directory)?.protectedBy;

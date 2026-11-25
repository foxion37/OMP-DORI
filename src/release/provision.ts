import { platform } from "../platform/index.ts";
import { readSourceBundle } from "./source-bundle.ts";
import type { ReleaseManifest } from "./types.ts";

function atLeast(observed: string, minimum: readonly number[]): boolean {
  const numbers = /^(\d+)\.(\d+)\.(\d+)(?:\s|$|\+)/.exec(observed)?.slice(1).map(Number);
  if (!numbers) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (numbers[i] !== minimum[i]) return numbers[i]! > minimum[i]!;
  }
  return true;
}

export function prerequisites(tools = true): void {
  if (!platform.supportsHeadlessRelease(platform.os, process.arch))
    throw new Error(`Unsupported release host: ${platform.os}/${process.arch}/headless`);
  if (!tools) return;
  if (!atLeast(Bun.version, [1, 4, 4])) throw new Error("Bun 1.4.4+ is required; install it before Cataly");
  if (!Bun.which("git")) throw new Error("git is required; install it before Cataly");
}

export function assertLock(source: string, manifest: ReleaseManifest): void {
  if (readSourceBundle(source).lock.nativeVersion !== manifest.requirements.omp)
    throw new Error("Release source bundle differs from its declared native identity");
}

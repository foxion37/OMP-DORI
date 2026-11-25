import { platform } from "../platform/index.ts";
import { readSetupFile, type SetupSnapshot } from "../setup-files.ts";
import { object } from "../update/config.ts";
import { headlessReleaseProfiles, nativeMetadata } from "./capabilities.ts";
import type { ReleaseManifest } from "./types.ts";

type ReleaseProfileBytes = (path: string) => Uint8Array | undefined;

/**
 * Verify against the target payload, not the update command's loaded release: it must run headless on this host, and
 * the preserved config may select only the runtimes this release provides.
 */
export function assertReleaseTarget(
  target: { readonly manifest: ReleaseManifest; readonly bytes: ReleaseProfileBytes },
  snapshot: SetupSnapshot,
): void {
  const { manifest, bytes } = target;
  const host = { platform: platform.os, arch: process.arch };
  const saved = readSetupFile(snapshot);
  const config: unknown = saved === undefined ? {} : JSON.parse(saved.toString("utf8"));
  if (!object(config)) throw new Error("Preserved config must be an object");
  if (config["runtime"] !== undefined && config["runtime"] !== "tern")
    throw new Error("Preserved config runtime must be tern when present");
  const session = config["sessionRuntime"];
  if (session !== undefined && session !== "headless" && session !== "tern")
    throw new Error("Preserved config sessionRuntime must be headless or tern when present");
  const profiles = headlessReleaseProfiles(manifest, bytes(nativeMetadata));
  if (!profiles.some((profile) => profile.platform === host.platform && profile.arch === host.arch))
    throw new Error(`Release ${manifest.tag} does not support ${host.platform}/${host.arch}/headless`);
}

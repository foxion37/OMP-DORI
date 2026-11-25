import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../update/source.ts";
import { readJson, realDirectory, regularFile } from "./files.ts";
import { NATIVE_UPDATE_FILES, validateNativeDependencies } from "./native-update-dependencies.ts";
import { compareNativeVersions, type NativeCandidate } from "./native-update.ts";
import { readSourceBundle } from "./source-bundle.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Inspect every entry, including directories and receipt, before reading any artifact payload. */
export function readNativeArtifact(source: string, directory: string): NativeCandidate {
  const files: string[] = [];
  const visit = (relative = "") => {
    realDirectory(join(directory, relative));
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(directory, path));
      if (stat.isDirectory()) {
        if (!NATIVE_UPDATE_FILES.some((file) => file.startsWith(`${path}/`)))
          throw new Error("Unexpected native artifact directory");
        visit(path);
      } else {
        if (!regularFile(join(directory, path)) || stat.size > 16 * 1024 * 1024)
          throw new Error("Invalid or oversized native artifact file");
        files.push(path);
      }
    }
  };
  visit();
  const value = readJson(join(directory, "candidate.json"));
  if (
    !object(value) ||
    Object.keys(value).sort().join() !==
      "commit,identity,nativeVersion,previous,previousIdentity,reason,sourceCommit,status,tag,version" ||
    value["version"] !== 1 ||
    !sha(value["sourceCommit"]) ||
    !sha(value["previous"]) ||
    !sha(value["commit"]) ||
    value["previous"] === value["commit"] ||
    !hash(value["previousIdentity"]) ||
    !hash(value["identity"]) ||
    typeof value["nativeVersion"] !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value["nativeVersion"]) ||
    typeof value["tag"] !== "string" ||
    ![value["nativeVersion"], `v${value["nativeVersion"]}`].includes(value["tag"]) ||
    !["candidate", "conflict", "held"].includes(String(value["status"])) ||
    !(
      (value["status"] === "candidate" && value["reason"] === "clean-three-way-apply") ||
      (value["status"] === "conflict" && value["reason"] === "three-way-apply-failed") ||
      (value["status"] === "held" &&
        ["unsupported-runtime-major", "unsupported-runtime-layout", "dependency-lock-refresh-failed"].includes(
          String(value["reason"]),
        ))
    )
  )
    throw new Error("Invalid native candidate receipt");
  const candidate = value as unknown as NativeCandidate;
  const expected = [
    "candidate.json",
    ...(candidate.status === "candidate" ? NATIVE_UPDATE_FILES : ["conflicts.patch"]),
  ];
  if (files.sort().join("\0") !== expected.sort().join("\0")) throw new Error("Unexpected native artifact files");
  const before = readSourceBundle(source);
  if (
    before.identity !== candidate.previousIdentity ||
    before.lock.commit !== candidate.previous ||
    compareNativeVersions(candidate.nativeVersion, before.lock.nativeVersion) <= 0
  )
    throw new Error("Native artifact differs from the exact previous bundle identity");
  if (candidate.status === "candidate") {
    const next = readSourceBundle(directory);
    if (
      !/^19\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.nativeVersion) ||
      next.identity !== candidate.identity ||
      next.lock.commit !== candidate.commit ||
      next.lock.nativeVersion !== candidate.nativeVersion ||
      next.lock.launcher !== before.lock.launcher ||
      next.lock.repository !== before.lock.repository
    )
      throw new Error("Native candidate differs from its authenticated bundle identity or supported runtime");
    validateNativeDependencies(source, directory, before.lock.nativeVersion, candidate.nativeVersion);
  } else if (digest(readFileSync(join(directory, "conflicts.patch"))) !== candidate.identity) {
    throw new Error("Native conflict artifact digest differs");
  }
  return candidate;
}

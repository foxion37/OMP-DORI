import { createHash } from "node:crypto";
import { join } from "node:path";
import { object } from "../update/config.ts";

/** The exact files a side home's wrappers publish; any other recorded inventory belongs to another installation. */
export const REFERENCE_FILES = ["bin/cataly", "bin/cataly-harness", "bin/omp", "bin/omp-cataly", "omp.yml"] as const;
export type Reference = { readonly bytes: string; readonly executable: boolean };
export type PendingReferences = {
  readonly before: Readonly<Record<string, string>>;
  readonly references: Readonly<Record<string, Reference>>;
};
export type ReferenceReceipts = {
  readonly recorded: Readonly<Record<string, string>>;
  readonly pending: PendingReferences | undefined;
};

export const referenceHash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const names = new Set<string>(REFERENCE_FILES);

export function nextReferenceDigests({ before, references }: PendingReferences): Readonly<Record<string, string>> {
  return {
    ...before,
    ...Object.fromEntries(Object.entries(references).map(([path, ref]) => [path, referenceHash(ref.bytes)])),
  };
}

function referenceDigests(value: unknown): Readonly<Record<string, string>> {
  if (!object(value)) throw new Error("Invalid consumer reference receipt");
  const digests: Record<string, string> = {};
  for (const [path, digest] of Object.entries(value)) {
    if (!names.has(path) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid consumer reference digest");
    digests[path] = digest;
  }
  return digests;
}

function parsePending(value: unknown): PendingReferences {
  if (!object(value) || Object.keys(value).sort().join() !== "before,references" || !object(value["references"]))
    throw new Error("Invalid pending consumer references");
  const before = referenceDigests(value["before"]);
  const references: Record<string, Reference> = {};
  for (const [path, ref] of Object.entries(value["references"])) {
    if (
      !names.has(path) ||
      !object(ref) ||
      Object.keys(ref).sort().join() !== "bytes,executable" ||
      typeof ref["bytes"] !== "string" ||
      ref["executable"] !== path.startsWith("bin/")
    )
      throw new Error("Invalid pending reference content");
    references[path] = { bytes: ref["bytes"], executable: path.startsWith("bin/") };
  }
  return { before, references };
}

export function readReferenceReceipts(root: string, read: (path: string) => unknown): ReferenceReceipts | undefined {
  const receipt = read(join(root, "consumer-references.json"));
  const transaction = read(join(root, "consumer-references-pending.json"));
  if (receipt === undefined && transaction === undefined) return undefined;
  const recorded = receipt === undefined ? {} : referenceDigests(receipt);
  const pending = transaction === undefined ? undefined : parsePending(transaction);
  const expected = pending ? nextReferenceDigests(pending) : recorded;
  if (
    Object.keys(expected).length !== REFERENCE_FILES.length ||
    !REFERENCE_FILES.every((path) => Object.hasOwn(expected, path))
  )
    throw new Error("Invalid or ambiguous consumer reference inventory");
  if (pending) {
    const same = (digests: Readonly<Record<string, string>>): boolean =>
      Object.keys(recorded).length === Object.keys(digests).length &&
      Object.entries(recorded).every(([path, digest]) => digest === digests[path]);
    if (!same(pending.before) && !same(expected)) throw new Error("Invalid consumer reference receipt");
  }
  return { recorded, pending };
}

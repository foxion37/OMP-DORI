/**
 * Evidence is what a lane changed, not that it spoke: the bytes of a file, or the result of a completed native tool
 * call, each kept as an identity and a sha256 fingerprint. Reports, checkpoints and filesystem observation activities
 * carry `evidenceRefs`; folding the journals gives the evidence clock, which moves when a file fingerprint changes
 * or a previously unseen tool-result fingerprint appears. Saying the same thing again, rewording it, touching a file
 * or rerunning a call that returns the same result moves the report clock only.
 */
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";

export type EvidenceRef =
  | { readonly kind: "file"; readonly ref: string; readonly fingerprint: string | null }
  | { readonly kind: "tool"; readonly ref: string; readonly fingerprint: string };
// File refs use canonical paths; null records an observed absence. Tool call ids locate results but do not identify them.
/** A journal record that may carry evidence: a report, observer activity or checkpoint. */
export type Evidenced = {
  readonly at: string;
  readonly evidenceRefs?: readonly EvidenceRef[] | undefined;
  readonly evidenceSequence?: number;
};
export type EvidenceClock = { readonly lastEvidenceAt: string | null; readonly lastEvidence: EvidenceRef | null };
/** A watched path's lstat identity and content fingerprint; the stat decides whether its bytes are read again. */
export type PathMark = readonly [stat: string, fingerprint: string | null, canonical?: string];

export class EvidenceError extends Error {}
/** The path changed under its read: an unknown to retry, not a failure. Explicit evidence still refuses it. */
export class UnstableEvidenceError extends EvidenceError {}

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const isEvidenceSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const isEvidenceRefs = (value: unknown): value is readonly EvidenceRef[] =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "kind" in item &&
      (item.kind === "file" || item.kind === "tool") &&
      "ref" in item &&
      typeof item.ref === "string" &&
      item.ref !== "" &&
      "fingerprint" in item &&
      ((typeof item.fingerprint === "string" && SHA256.test(item.fingerprint)) ||
        (item.kind === "file" && item.fingerprint === null)),
  );

// A file is one identity whose bytes change. A rerun tool call gets a new id, so a tool result is identified by its
// content.
const identity = (ref: EvidenceRef): string => (ref.kind === "file" ? `file\0${ref.ref}` : `tool\0${ref.fingerprint}`);

const fold = (records: Iterable<Evidenced>): { seen: Map<string, string | null>; clock: EvidenceClock } => {
  const seen = new Map<string, string | null>();
  let clock: EvidenceClock = { lastEvidenceAt: null, lastEvidence: null };
  // New evidence is sequenced under one writer lock, so equal-ms journals replay acceptance order, not source order.
  // Old records remain readable; missing sequences sort before new ones and otherwise retain their input order.
  const ordered = [...records]
    .filter((record) => record.evidenceRefs?.length)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.evidenceSequence ?? 0) - (b.evidenceSequence ?? 0));
  for (const record of ordered) {
    for (const ref of record.evidenceRefs ?? []) {
      const key = identity(ref);
      if (seen.get(key) === ref.fingerprint) continue;
      seen.set(key, ref.fingerprint);
      clock = { lastEvidenceAt: record.at, lastEvidence: ref };
    }
  }
  return { seen, clock };
};

/** When the lane's evidence last changed. Records without `evidenceRefs` never move it. */
export const evidenceClock = (records: Iterable<Evidenced>): EvidenceClock => fold(records).clock;

/** The refs that would move the clock if recorded after `records`. */
export const novelEvidence = (records: Iterable<Evidenced>, refs: readonly EvidenceRef[]): EvidenceRef[] => {
  const { seen } = fold(records);
  return refs.filter((ref) => {
    const key = identity(ref);
    if (seen.get(key) === ref.fingerprint) return false;
    seen.set(key, ref.fingerprint);
    return true;
  });
};

const sameFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// One reused buffer: reads are synchronous, so no two hashes share it at once.
const chunk = Buffer.allocUnsafe(64 * 1024);

/**
 * sha256 of the regular file `path` that lstat saw as `expected`, or null when it is no longer that file or changed
 * while being read. The open cannot block on a FIFO swapped in after the lstat (O_NONBLOCK) or follow a link
 * (O_NOFOLLOW).
 */
const hashRegular = (path: string, expected: BigIntStats): string | null => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameFile(before, expected)) return null;
    const hash = createHash("sha256");
    let total = 0n;
    let read = readSync(fd, chunk, 0, chunk.length, null);
    while (read > 0) {
      total += BigInt(read);
      if (total > before.size) return null;
      hash.update(chunk.subarray(0, read));
      read = readSync(fd, chunk, 0, chunk.length, null);
    }
    return total === before.size && sameFile(fstatSync(fd, { bigint: true }), before) ? hash.digest("hex") : null;
  } finally {
    closeSync(fd);
  }
};

const errno = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** A file the lane selects as evidence: its canonical path and the sha256 of its bytes, read and checked stable. */
export const fileEvidence = (path: string, cwd: string): EvidenceRef => {
  const source = resolve(cwd, path);
  const unstable = () =>
    new UnstableEvidenceError(`evidence file ${path} changed while it was read; record it again once it is stable`);
  try {
    const ref = realpathSync(source);
    const stat = lstatSync(ref, { bigint: true });
    if (!stat.isFile()) throw new EvidenceError(`evidence file ${path} is not a regular file`);
    const fingerprint = hashRegular(ref, stat);
    // A link moved to another file during the read would credit these bytes to the wrong path.
    if (fingerprint === null || realpathSync(source) !== ref || !sameFile(lstatSync(ref, { bigint: true }), stat))
      throw unstable();
    return { kind: "file", ref, fingerprint };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    const code = errno(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new EvidenceError(`evidence file ${path} does not exist`);
    if (code === "ELOOP")
      throw new EvidenceError(`evidence file ${path} cannot be resolved safely (symlink loop or changed link)`);
    if (code !== undefined) throw new EvidenceError(`evidence file ${path} cannot be read (${code})`);
    throw error;
  }
};

const RACY = "racy:";
// Filesystem ctime can be coarse: a same-size rewrite may share the preceding read's stat key. A key stays racy until
// one full unchanged second has elapsed after its ctime; only a settled key may stand for the bytes read under it.
const statKey = (stat: BigIntStats, observedAt: number): string => {
  const settled = Math.floor(observedAt / 1_000) > Number(stat.ctimeNs / 1_000_000_000n) + 1;
  return `${settled ? "" : RACY}${stat.mode}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
};

/** A racy mark's bytes were read too close to its ctime: an equal stat alone cannot show they are still the same. */
export const racyMark = (mark: PathMark): boolean => mark[0].startsWith(RACY);

/**
 * Whether one lstat still shows `path` as its settled mark was taken: the same stat key, or still absent. A racy mark
 * never holds, and a failed lstat is unknown, not unchanged. Its bytes are not read again.
 */
export const markHolds = (path: string, mark: PathMark, observedAt = Date.now()): boolean => {
  if (racyMark(mark)) return false;
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return (stat === undefined ? "missing" : statKey(stat, observedAt)) === mark[0];
  } catch (error) {
    const code = errno(error);
    return (code === "ENOENT" || code === "ENOTDIR") && mark[0] === "missing";
  }
};

// Whether lstat positively shows the path changed since a read began: other metadata, or confirmed gone. A failing
// lstat (EACCES, EIO) confirms nothing, so the read's own error stays a real failure.
const changedSince = (path: string, stat: BigIntStats): boolean => {
  try {
    return !sameFile(lstatSync(path, { bigint: true }), stat);
  } catch (error) {
    const code = errno(error);
    return code === "ENOENT" || code === "ENOTDIR";
  }
};

/**
 * A quiet sweep reuses a settled lstat mark. Recent ctime is re-read before a mark becomes reusable;
 * touching a file rereads the same bytes without admitting new evidence.
 * Links use target text, directories use entry names, and special files are never opened. Read failures and races
 * propagate as unknown observations, never as a successful reading of previous bytes. A read that fails or disagrees
 * after lstat confirms the path was rewritten, replaced or removed under it throws UnstableEvidenceError; any other
 * error, including one whose recheck fails too, is rethrown as it is.
 */
export const pathMark = (path: string, previous?: PathMark, observedAt = Date.now()): PathMark => {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    const code = errno(error);
    if (code === "ENOENT" || code === "ENOTDIR")
      return previous?.[2] ? ["missing", null, previous[2]] : ["missing", null];
    throw error;
  }
  // Re-read a racy key until one full unchanged second has elapsed, then retain a reusable mark.
  const key = statKey(stat, observedAt);
  if (!key.startsWith(RACY) && previous?.[0] === key) return previous;
  try {
    if (stat.isFile()) {
      const evidence = fileEvidence(path, "/");
      if (!sameFile(lstatSync(path, { bigint: true }), stat))
        throw new UnstableEvidenceError(`evidence file ${path} changed while it was read`);
      return [key, evidence.fingerprint, evidence.ref];
    }
    if (stat.isSymbolicLink()) return [key, sha256(`link\0${readlinkSync(path)}`)];
    if (stat.isDirectory()) return [key, sha256(`dir\0${readdirSync(path).sort().join("\0")}`)];
  } catch (error) {
    if (error instanceof UnstableEvidenceError || !changedSince(path, stat)) throw error;
    throw new UnstableEvidenceError(`${path} changed while it was read`);
  }
  return [key, "special"];
};

import { object } from "./config.ts";
import { publicLocalTree } from "./publish-export.ts";
import type { PublicationProcess } from "./publish-process.ts";
import {
  type InitialSourcePins,
  type PublicationBasis,
  PublicationHold,
  type PublicationRecord,
} from "./publish-types.ts";
import { persistState, readState } from "./state.ts";
import type { SourceManifest, UpdateContext, UpdateJob, UpdateState } from "./types.ts";

const PIN_KEYS = ["main", "sourceHash", "exportHash", "baseUpstream", "upstream"] as const;
const expectedPins = (job: UpdateJob, manifest: SourceManifest, main: string): InitialSourcePins => ({
  main,
  sourceHash: job.inputs!.local.hash,
  exportHash: manifest.hash,
  baseUpstream: job.baseUpstream,
  upstream: job.upstream,
});
const samePins = (value: unknown, expected: InitialSourcePins): value is InitialSourcePins =>
  object(value) &&
  Object.keys(value).length === PIN_KEYS.length &&
  PIN_KEYS.every((key) => value[key] === expected[key]);

/** Admission precedes publication intent. A claimed initial exception is never available to another job. */
export async function publicationBasis(
  ctx: UpdateContext,
  state: UpdateState,
  process: PublicationProcess,
  job: UpdateJob,
  manifest: SourceManifest,
  main: string,
): Promise<PublicationBasis> {
  const localTree = await publicLocalTree(process, job);
  const mainTree = (await process.git(["rev-parse", `${main}^{tree}`])).trim();
  const claimed = readState(ctx).initialSourceJob;
  if (claimed !== state.initialSourceJob)
    throw new PublicationHold("initial-source job claim changed; retain durable state");
  if (localTree === mainTree && claimed !== job.id) return { kind: "matched-main" };
  const pins = process.config.initialSource;
  if (!samePins(pins, expectedPins(job, manifest, main))) {
    throw new PublicationHold(
      "frozen public local source differs from publication main or approved initial pins; owner content was retained",
    );
  }
  if (claimed !== undefined && claimed !== job.id) {
    throw new PublicationHold("initial-source publication exception is already claimed by another job");
  }
  if (state.configHash !== ctx.configHash || state.jobs[job.upstream] !== job.id) {
    throw new PublicationHold("initial-source publication requires its registered durable job");
  }
  if (claimed === undefined) {
    state.initialSourceJob = job.id;
    persistState(ctx, state);
  }
  return { kind: "initial-source", pins: { ...pins } };
}

/** Resume verifies the original decision and all frozen bindings; it never decides a new bootstrap exception. */
export function assertPublicationBasis(
  ctx: UpdateContext,
  state: UpdateState,
  job: UpdateJob,
  manifest: SourceManifest,
  record: PublicationRecord,
): void {
  const basis: unknown = record.basis;
  if (object(basis) && basis["kind"] === "matched-main" && Object.keys(basis).length === 1) {
    if (state.initialSourceJob !== job.id) return;
  } else if (
    object(basis) &&
    basis["kind"] === "initial-source" &&
    Object.keys(basis).length === 2 &&
    samePins(basis["pins"], expectedPins(job, manifest, record.expectedMain)) &&
    samePins(ctx.config.promotion!.publish.initialSource, basis["pins"]) &&
    state.initialSourceJob === job.id &&
    readState(ctx).initialSourceJob === job.id
  ) {
    return;
  }
  throw new PublicationHold(
    "persisted publication basis does not match its frozen job, configuration and initial-source claim",
  );
}

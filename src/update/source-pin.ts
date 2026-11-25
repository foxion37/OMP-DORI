import type { SourceEntry, SourceManifest } from "./types.ts";

const BUNDLE = /^native-omp\.(?:lock|patch)$/;

/** Payloads are an opaque local dependency during a Cataly-only upstream port, never model update targets. */
export const catalyPin = (manifest: SourceManifest): readonly SourceEntry[] =>
  manifest.files.filter((file) => BUNDLE.test(file.path) || file.path.startsWith("native-addon/"));

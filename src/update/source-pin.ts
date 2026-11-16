import type { SourceEntry, SourceManifest } from "./types.ts";

const BUNDLE = /^(?:native-omp|omp-ulw)\.(?:lock|overlay\.lock|patch)$/;

/** Payloads are an opaque local dependency during a Dori-only upstream port, never model update targets. */
export const doriPin = (manifest: SourceManifest): readonly SourceEntry[] =>
  manifest.files.filter(
    (file) => BUNDLE.test(file.path) || file.path.startsWith("native-addon/") || file.path.startsWith("ref/omp-ulw/"),
  );

import type { SourceManifest } from "../update/types.ts";

export type ReleaseManifest = {
  readonly version: 2;
  readonly product: "cataly";
  readonly releaseVersion: string;
  readonly tag: string;
  readonly commit: string;
  readonly tree: string;
  readonly prerelease: boolean;
  readonly archive: {
    readonly name: string;
    readonly root: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly source: SourceManifest;
  readonly requirements: {
    readonly omp: string;
  };
};

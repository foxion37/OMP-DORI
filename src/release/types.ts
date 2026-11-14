import type { SourceManifest } from "../update/types.ts";

export type ReleaseManifest = {
  readonly version: 1;
  readonly product: "omp-dori";
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
    readonly platform: "linux";
    readonly arch: "x64";
    readonly bun: "1.4.4";
    readonly omp: "18.18.8";
    readonly runtime: "herdr";
    readonly messenger: "discord";
  };
  readonly ompUlw: {
    readonly repository: "https://github.com/dbc-hbin/omp-ulw.git";
    readonly commit: string;
  };
};

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicSource } from "../src/update/publish-export.ts";
import { sourceManifest } from "../src/update/source.ts";
import { git, publicationFixture } from "./update-setup.ts";

type Binding =
  | "exact"
  | "source-mismatch"
  | "main-mismatch"
  | "export-mismatch"
  | "base-mismatch"
  | "upstream-mismatch";

export async function bootstrapFixture(binding: Binding = "exact", reporter = false, referenceExportHash?: string) {
  const exportHash = referenceExportHash ?? publicSource((await publicationFixture()).job).hash;
  return publicationFixture(({ directory, localSource }) => {
    // Model an older local replay input and an exact separately approved final export.
    writeFileSync(join(localSource, "src/behavior.ts"), "export const behavior = 0;\n");
    const remote = join(directory, "publication.git");
    const upstreamRemote = join(directory, "remote");
    return {
      ...(reporter
        ? {
            reporter: {
              name: "notify",
              argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);", "{text}"],
              timeoutMs: 10_000,
            },
          }
        : {}),
      promotion: {
        publish: {
          remote,
          ref: "refs/heads/main",
          author: { name: "Initial source fixture", email: "bootstrap@example.invalid" },
          initialSource: {
            main: binding === "main-mismatch" ? "0".repeat(40) : git(remote, "rev-parse", "main"),
            sourceHash: binding === "source-mismatch" ? "0".repeat(64) : sourceManifest(localSource).hash,
            exportHash: binding === "export-mismatch" ? "0".repeat(64) : exportHash,
            baseUpstream: binding === "base-mismatch" ? "0".repeat(40) : git(upstreamRemote, "rev-parse", "HEAD^"),
            upstream: binding === "upstream-mismatch" ? "0".repeat(40) : git(upstreamRemote, "rev-parse", "HEAD"),
          },
        },
      },
    };
  });
}

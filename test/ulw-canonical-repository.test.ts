import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { RELEASE_REPOSITORY } from "../scripts/release-gate.ts";
import { object } from "../src/update/config.ts";

test("daily ULW preparation and release publication admit only the renamed canonical repository", async () => {
  expect(RELEASE_REPOSITORY).toBe("vntrevx/Cataly");
  for (const [file, job] of [
    ["ulw-update.yml", "prepare"],
    ["release.yml", "publish"],
  ] as const) {
    const workflow = Bun.YAML.parse(await Bun.file(new URL(`../.github/workflows/${file}`, import.meta.url)).text());
    if (!object(workflow) || !object(workflow["jobs"])) throw new Error("Workflow jobs must be a mapping");
    expect(workflow["jobs"][job]).toHaveProperty("if", "github.repository == 'vntrevx/Cataly'");
    expect(workflow["permissions"]).toEqual({ contents: "read" });
    if (file === "ulw-update.yml") {
      expect(workflow["on"]).toMatchObject({ schedule: [{ cron: "0 3 * * *" }] });
      expect(workflow["on"]).toHaveProperty("workflow_dispatch");
    }
  }
});

test.each(["vntrevx/Cataly", "vntrevx/omp-dori", "other/Cataly", "vntrevx/Cataly-extra", ""])(
  "the real ULW publisher CLI enforces its canonical admission before input or GitHub access: %s",
  (repository) => {
    // No --from: the canonical identity reaches argument validation without publishing anything.
    const result = Bun.spawnSync(
      [process.execPath, fileURLToPath(new URL("../scripts/update-ulw-publish.ts", import.meta.url))],
      {
        env: { PATH: process.env["PATH"], GITHUB_REPOSITORY: repository },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      repository === "vntrevx/Cataly"
        ? "Usage: bun scripts/update-ulw-publish.ts --from DIRECTORY\n"
        : "ULW publication is restricted to the canonical repository\n",
    );
  },
);

import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DoriUpdater } from "../src/update/controller.ts";
import { verifyCandidate } from "../src/update/pipeline.ts";
import { prepareCandidate } from "../src/update/prepare.ts";
import { candidateReport } from "../src/update/report.ts";
import { parseReview } from "../src/update/review.ts";
import { gitIdentity, sourceManifest } from "../src/update/source.ts";
import { REVIEW_ITEMS, type UpdateJob } from "../src/update/types.ts";
import { fixture } from "./update-setup.ts";

const normalized = "export const behavior = 2;\n";

async function prepared(mutatingCheck: boolean) {
  const f = fixture();
  const config = {
    ...f.config,
    provision: [
      {
        name: "normalize",
        argv: [
          process.execPath,
          "-e",
          `if ((await Bun.file("../job.json").json()).sourceHash !== undefined) throw new Error("source froze before preparation");
await Bun.write("src/behavior.ts", ${JSON.stringify(normalized)});`,
        ],
        timeoutMs: 10_000,
      },
    ],
    checks: [
      {
        name: "verify-normalized",
        argv: [
          process.execPath,
          "-e",
          `if (await Bun.file("src/behavior.ts").text() !== ${JSON.stringify(normalized)}) throw new Error("preparation not visible");
const source = await Bun.file("../ported-source.json").json();
const job = await Bun.file("../job.json").json();
if (source.hash !== job.sourceHash) throw new Error("final source was not persisted before checks");
console.log(job.sourceHash);
${mutatingCheck ? 'await Bun.write("src/behavior.ts", "export const behavior = 3;\\n");' : ""}`,
        ],
        timeoutMs: 10_000,
      },
    ],
  };
  const updater = new DoriUpdater(config);
  const id = "c".repeat(64);
  const directory = join(config.root, "jobs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  // Exercise the real preparation/verification phase directly, without inventing worker or reviewer success.
  const job: UpdateJob = {
    version: 1,
    id,
    upstream: config.baseUpstream,
    baseUpstream: config.baseUpstream,
    configHash: updater.context.configHash,
    createdAt: at,
    updatedAt: at,
    phase: "porting",
    candidate: join(directory, "candidate"),
    directory,
    commands: [],
    history: [{ phase: "porting", at }],
  };
  await prepareCandidate(updater.context, job);
  return { updater, job, metadata: gitIdentity(job.candidate), before: sourceManifest(job.candidate).hash };
}

test("explicit preparation normalizes before final binding; check writes and stale review hashes still hold", async () => {
  const { updater, job, metadata, before } = await prepared(false);
  const finalHash = await verifyCandidate(updater.context, job, metadata);
  expect(finalHash).not.toBe(before);
  expect(finalHash).toBe(sourceManifest(job.candidate).hash);
  expect(job.sourceHash).toBe(finalHash);
  expect(JSON.parse(readFileSync(join(job.directory, "job.json"), "utf8")).sourceHash).toBe(finalHash);
  const report = candidateReport(updater.context, job);
  expect(report.provision[0]?.exitCode).toBe(0);
  expect(report.provision[0]?.receipt?.sourceHash).toBeUndefined();
  expect(report.checks[0]?.exitCode).toBe(0);
  expect(report.checks[0]?.receipt?.sourceHash).toBe(finalHash);
  expect(readFileSync(report.checks[0]!.receipt!.stdout, "utf8").trim()).toBe(finalHash);
  const rejection = {
    version: 1,
    sourceHash: finalHash,
    verdict: "reject",
    checklist: Object.fromEntries(
      REVIEW_ITEMS.map((name) => [
        name,
        { status: "unknown", evidence: "Protocol fixture only; no reviewer ran in this phase test." },
      ]),
    ),
    findings: ["No model review was executed."],
    limitations: ["Verification-phase unit coverage only."],
  };
  expect(parseReview(`DORI_UPDATE_REVIEW ${JSON.stringify(rejection)}`, finalHash).sourceHash).toBe(finalHash);
  expect(() =>
    parseReview(`DORI_UPDATE_REVIEW ${JSON.stringify({ ...rejection, sourceHash: before })}`, finalHash),
  ).toThrow("stale source");

  const changed = await prepared(true);
  await expect(verifyCandidate(changed.updater.context, changed.job, changed.metadata)).rejects.toThrow("stale");
  expect(changed.job.commands.at(-1)?.exitCode).toBe(0);
  expect(changed.job.sourceHash).not.toBe(sourceManifest(changed.job.candidate).hash);
  expect(changed.job.phase).toBe("verifying");
  expect(changed.job.review).toBeUndefined();
});

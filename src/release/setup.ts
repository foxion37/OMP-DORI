import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSetupFile, readSetupFile, setupPreview, type SetupSnapshot } from "../setup-files.ts";
import { extractArchive } from "./archive.ts";
import type { VerifiedBundle } from "./bundle.ts";
import { type ConsumerPaths, isPrimaryConsumer } from "./files.ts";
import { assertLock } from "./provision.ts";

type ConsumerConfigPlan = { readonly text: string | Buffer; readonly keys: readonly string[] };

export function consumerConfigPlan(paths: ConsumerPaths, snapshot: SetupSnapshot, source: string): ConsumerConfigPlan {
  if (snapshot.path !== paths.config) throw new Error("Configuration snapshot belongs to another installation");
  const saved = readSetupFile(snapshot);
  if (saved !== undefined) return { text: saved, keys: [] };
  const example = JSON.parse(readFileSync(join(source, "skills/cataly-mode/references/config.example.json"), "utf8"));
  const keys: string[] = [];
  delete example.runtime;
  delete example.sessionRuntime;
  if (!isPrimaryConsumer(paths)) {
    example.stateDir = join(paths.cataly, "state");
    keys.push("stateDir");
  }
  example.agentCommand = [
    join(paths.cataly, "bin/omp"),
    ...(example.agentCommand?.slice(1) ?? ["--cataly-role", "lane", "--model", "{model}", "{prompt}"]),
  ];
  keys.push("agentCommand");
  return { text: `${JSON.stringify(example, null, 2)}\n`, keys };
}

/** Verify the selected bytes in disposable storage, without preparing dependencies or touching the installation. */
export function previewConsumerSetup(paths: ConsumerPaths, bundle: VerifiedBundle, snapshot: SetupSnapshot) {
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "cataly-setup-preview-")));
  let plan: ConsumerConfigPlan;
  try {
    const source = join(stage, "source");
    extractArchive(bundle.files, bundle.manifest, source);
    assertLock(source, bundle.manifest);
    plan = consumerConfigPlan(paths, snapshot, source);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  assertSetupFile(snapshot);
  return setupPreview(snapshot, plan.text, plan.keys);
}

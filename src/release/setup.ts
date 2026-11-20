import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { assertSetupFile, readSetupFile, setupPreview, type SetupSnapshot } from "../setup-files.ts";
import { extractArchive } from "./archive.ts";
import type { VerifiedBundle } from "./bundle.ts";
import { type ConsumerPaths, readJson } from "./files.ts";
import { assertLock, dependencyPlan } from "./provision.ts";

export function setupRuntime(snapshot: SetupSnapshot, requested?: string): string {
  assertSetupFile(snapshot);
  if (snapshot.stamp !== null) {
    const config = readJson(snapshot.path);
    if (config === null || typeof config !== "object" || Array.isArray(config))
      throw new Error("Preserved config must be an object");
    if (!("runtime" in config))
      throw new Error(
        'Preserved config must explicitly select runtime: set "runtime" to "herdr" or "hc" before retrying',
      );
    if (typeof config.runtime !== "string") throw new Error("Preserved config runtime must be a string");
    if (config.runtime !== "herdr" && config.runtime !== "hc")
      throw new Error("Preserved config runtime must be herdr or hc");
    if (requested !== undefined && requested !== config.runtime)
      throw new Error("Selected runtime conflicts with preserved config runtime");
    requested ??= config.runtime;
  }
  assertSetupFile(snapshot);
  return requested ?? platform.defaultRuntime();
}

type ConsumerConfigPlan = { readonly text: string | Buffer; readonly keys: readonly string[] };

export function consumerConfigPlan(
  paths: ConsumerPaths,
  snapshot: SetupSnapshot,
  source: string,
  dependency: string,
  boundNative: boolean,
): ConsumerConfigPlan {
  if (snapshot.path !== paths.config) throw new Error("Configuration snapshot belongs to another installation");
  const saved = readSetupFile(snapshot);
  if (saved !== undefined) return { text: saved, keys: [] };
  const example = JSON.parse(readFileSync(join(source, "skills/dori-mode/references/config.example.json"), "utf8"));
  example.ompUlwPath = dependency;
  example.runtime = platform.defaultRuntime();
  const keys = ["ompUlwPath", "runtime"];
  if (paths.dori !== join(paths.home, ".dori")) {
    example.stateDir = join(paths.dori, "state");
    keys.push("stateDir");
  }
  if (boundNative || paths.dori !== join(paths.home, ".dori")) {
    example.agentCommand = [
      join(paths.dori, "bin/omp"),
      ...(example.agentCommand?.slice(1) ?? ["--dori-role", "lane", "--model", "{model}", "{prompt}"]),
    ];
    keys.push("agentCommand");
  }
  return { text: `${JSON.stringify(example, null, 2)}\n`, keys };
}

/** Verify the selected bytes in disposable storage, without preparing dependencies or touching the installation. */
export function previewConsumerSetup(paths: ConsumerPaths, bundle: VerifiedBundle, snapshot: SetupSnapshot) {
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "dori-setup-preview-")));
  let plan: ConsumerConfigPlan;
  try {
    const source = join(stage, "source");
    extractArchive(bundle.files, bundle.manifest, source);
    assertLock(source, bundle.manifest);
    const dependency = join(dependencyPlan(paths, bundle.manifest, source).directory, "index.ts");
    plan = consumerConfigPlan(paths, snapshot, source, dependency, bundle.manifest.requirements.omp === "18.20.0");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  assertSetupFile(snapshot);
  return setupPreview(snapshot, plan.text, plan.keys);
}

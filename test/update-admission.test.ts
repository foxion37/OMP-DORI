import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "../src/update/config.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { verifyCandidate } from "../src/update/pipeline.ts";
import { prepareCandidate } from "../src/update/prepare.ts";
import { restoreUpdate, snapshotUpdate } from "../src/update/recovery.ts";
import { readPortResult } from "../src/update/review.ts";
import { assertFrozen, assertSource, freezeSource, gitIdentity, sourceManifest } from "../src/update/source.ts";
import type { UpdateConfig, UpdateJob } from "../src/update/types.ts";
import { fixture, git } from "./update-setup.ts";

const dependencies = ["node_modules", "skills/dori-mode/scripts/node_modules", "ref/omp-ulw/node_modules"];

async function prepared(overrides: Partial<Pick<UpdateConfig, "provision" | "checks">> = {}) {
  const f = fixture();
  mkdirSync(join(f.localSource, "ref/omp-ulw"), { recursive: true });
  const updater = new DoriUpdater({
    ...f.config,
    checks: [
      {
        name: "inspect",
        argv: [
          process.execPath,
          "-e",
          'if ((await Bun.file("package.json").json()).name !== "dori-superagent") throw new Error("wrong source");',
        ],
        timeoutMs: 10_000,
      },
    ],
    ...overrides,
  });
  const directory = join(f.config.root, "jobs", "d".repeat(64));
  mkdirSync(directory, { recursive: true });
  const at = new Date().toISOString();
  const job: UpdateJob = {
    version: 1,
    id: "d".repeat(64),
    upstream: f.config.baseUpstream,
    baseUpstream: f.config.baseUpstream,
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
  return { ...f, updater, job, metadata: gitIdentity(job.candidate) };
}

for (const revision of ["base", "incoming"] as const) {
  test(`tracked executable bin in pinned ${revision} holds before a worker or check`, async () => {
    const f = fixture();
    const before = sourceManifest(f.remote).hash;
    f.write(f.remote, "bin/dori", "#!/bin/sh\nexit 0\n");
    chmodSync(join(f.remote, "bin/dori"), 0o755);
    git(f.remote, "add", "bin/dori");
    git(f.remote, "commit", "-m", "Add tracked executable");
    const payload = git(f.remote, "rev-parse", "HEAD");
    expect(git(f.remote, "ls-files", "bin/dori")).toBe("bin/dori");
    expect(sourceManifest(f.remote).hash).toBe(before);
    expect(sourceManifest(f.remote).excluded).toContain("bin");
    if (revision === "base") {
      git(f.remote, "rm", "bin/dori");
      git(f.remote, "commit", "-m", "Remove executable in incoming only");
    }
    const updater = new DoriUpdater({
      ...f.config,
      baseUpstream: revision === "base" ? payload : f.config.baseUpstream,
    });
    const job = (await updater.once("stage")).job!;
    expect(job.phase).toBe("failed");
    expect(job.problem).toBeDefined();
    expect(job.inputs).toBeUndefined();
    expect(job.sourceHash).toBeUndefined();
    expect(job.commands.some((command) => ["port", "types", "review"].includes(command.name))).toBe(false);
    expect(job.history.some(({ phase }) => phase === "ready")).toBe(false);
    if (revision === "incoming") {
      expect(() => snapshotUpdate(updater.context, job.id, join(f.directory, "snapshot"))).toThrow(UpdateError);
      expect(existsSync(join(f.directory, "snapshot/source"))).toBe(false);
    }
  });
}

for (const path of [
  "bin/dori",
  "ref/other-library/index.ts",
  "ref/omp-ulw/bin/task",
  "ref/omp-ulw/.cache/payload.ts",
  "ref/omp-ulw/.omp/SYSTEM.md",
  "src/payload.tmp",
]) {
  test(`excluded local code ${path} holds without losing an adaptation or copying auth`, async () => {
    const f = fixture();
    const bytes = "export const excludedAdaptation = true;\n";
    f.write(f.localSource, path, bytes);
    f.write(f.localSource, "ref/omp-ulw/auth/token.json", '{"token":"private-fixture"}\n');
    const omitted = sourceManifest(f.localSource).excluded.find(
      (item) => path === item || path.startsWith(`${item}/`),
    )!;
    expect(omitted).toBeDefined();
    const job = (await f.updater.once("stage")).job!;
    expect(job.phase).toBe("failed");
    expect(job.problem).toBeDefined();
    expect(job.commands.some((command) => command.name === "port")).toBe(false);
    expect(job.inputs).toBeUndefined();
    expect(job.sourceHash).toBeUndefined();
    expect(readFileSync(join(f.localSource, path), "utf8")).toBe(bytes);
    expect(existsSync(join(job.candidate, path))).toBe(false);
    expect(existsSync(join(job.directory, "inputs/local"))).toBe(false);
    expect(existsSync(join(job.candidate, "ref/omp-ulw/auth"))).toBe(false);
    expect(job.history.some(({ phase }) => phase === "ready")).toBe(false);
  });
}

test("gitignored adaptations retain filesystem hashes, coverage, frozen review input and recovery", async () => {
  const f = fixture();
  const path = "src/ignored-adaptation.ts";
  const bytes = "export const ignoredAdaptation = true;\n";
  f.write(f.localSource, ".gitignore", `${path}\n`);
  f.write(f.localSource, path, bytes);
  chmodSync(join(f.localSource, path), 0o755);
  git(f.localSource, "init", "-b", "main");
  expect(git(f.localSource, "check-ignore", "--no-index", path)).toBe(path);
  f.write(f.localSource, "ref/omp-ulw/runtime.ts", "export const frozenLibrary = true;\n");
  git(join(f.localSource, "ref/omp-ulw"), "init", "-b", "main");
  const privatePaths = ["config.json", "ref/omp-ulw/auth/token.json", "ref/omp-ulw/nested/credentials/token.json"];
  for (const secret of privatePaths) f.write(f.localSource, secret, '{"token":"private-fixture"}\n');
  f.write(f.localSource, "skills/dori-mode/scripts/node_modules/private/index.js", "installed dependency\n");
  const job = (await f.updater.once("stage")).job!;
  expect(job.commands.at(-1)?.name).toBe("port");
  expect(job.inputs!.local.excluded).toContain("ref/omp-ulw/.git");
  expect(job.inputs!.local.excluded).toContain("skills/dori-mode/scripts/node_modules");
  expect(job.inputs!.changedPaths).toContain(path);
  expect(job.inputs!.changedPaths).toContain("ref/omp-ulw/runtime.ts");
  expect(job.inputs!.local.files.find((file) => file.path === path)?.executable).toBe(true);
  expect(readFileSync(join(job.directory, "inputs/local", path), "utf8")).toBe(bytes);
  writeFileSync(
    join(job.directory, "port-result.json"),
    JSON.stringify({
      version: 1,
      baseHash: job.inputs!.base.hash,
      localHash: job.inputs!.local.hash,
      upstreamHash: job.inputs!.incoming.hash,
      coverage: job
        .inputs!.changedPaths.filter((item) => item !== path)
        .map((item) => ({ path: item, disposition: "preserved", evidence: "frozen source" })),
    }),
  );
  expect(() => readPortResult(job)).toThrow(UpdateError);
  const snapshot = snapshotUpdate(f.updater.context, job.id, join(f.directory, "snapshot"));
  const restored = restoreUpdate(f.updater.context, snapshot, join(f.directory, "restored"));
  expect(sourceManifest(join(restored, "inputs/local")).hash).toBe(job.inputs!.local.hash);
  expect(readFileSync(join(restored, "inputs/local", path), "utf8")).toBe(bytes);
  expect(JSON.parse(readFileSync(join(restored, "job.json"), "utf8")).phase).toBe("interrupted");
  for (const secret of privatePaths) {
    expect(existsSync(join(job.directory, "inputs/local", secret))).toBe(false);
    expect(existsSync(join(restored, "inputs/local", secret))).toBe(false);
    expect(existsSync(join(job.candidate, secret))).toBe(false);
  }
});

test("nested Git and installed-package metadata survive trusted provision allowance before the final freeze", async () => {
  const f = await prepared({
    provision: [
      {
        name: "normalize",
        argv: [
          process.execPath,
          "-e",
          `await Bun.write("src/behavior.ts", "export const behavior = 2;\\n");
for (const path of ${JSON.stringify(dependencies)}) await Bun.write(path + "/package/index.js", "export default 1;\\n");`,
        ],
        timeoutMs: 10_000,
      },
    ],
  });
  mkdirSync(join(f.job.candidate, "nested"));
  git(join(f.job.candidate, "nested"), "init", "-b", "main");
  for (const path of dependencies) expect(existsSync(join(f.job.candidate, path))).toBe(false);
  const before = sourceManifest(f.job.candidate).hash;
  await verifyCandidate(f.updater.context, f.job, f.metadata);
  expect(f.job.sourceHash).not.toBe(before);
  expect(sourceManifest(f.job.candidate).excluded).toContain("nested/.git");
  for (const path of dependencies) expect(sourceManifest(f.job.candidate).excluded).toContain(path);
  expect(f.job.commands.find((command) => command.name === "normalize")?.sourceHash).toBeUndefined();
  expect(f.job.commands.at(-1)?.sourceHash).toBe(f.job.sourceHash);
  expect(() => assertSource(f.job)).not.toThrow();
  expect(f.job.phase).toBe("verifying");
  expect(f.job.review).toBeUndefined();
});

for (const scenario of ["before", "during", "after", ...dependencies] as const) {
  test(`excluded candidate executable ${scenario} verification holds even with an unchanged source hash`, async () => {
    const moment = dependencies.includes(scenario) ? "before" : scenario;
    const payload = moment === scenario ? "nested/.cache/run.js" : `${scenario}/package/index.js`;
    const kind = moment === "before" ? "upstream" : "candidate";
    const f = await prepared(
      moment === "during"
        ? {
            checks: [
              {
                name: "write-hidden",
                argv: [
                  process.execPath,
                  "-e",
                  `import { chmodSync } from "node:fs";
await Bun.write(${JSON.stringify(payload)}, "console.log('hidden');\\n");
chmodSync(${JSON.stringify(payload)}, 0o755);`,
                ],
                timeoutMs: 10_000,
              },
            ],
          }
        : { provision: [{ name: "provision", argv: ["touch", "../provisioned"], timeoutMs: 10_000 }] },
    );
    const before = { hash: sourceManifest(f.job.candidate).hash, commands: f.job.commands.length };
    if (moment === "after") await verifyCandidate(f.updater.context, f.job, f.metadata);
    if (moment !== "during") {
      f.write(f.job.candidate, payload, "console.log('hidden');\n");
      chmodSync(join(f.job.candidate, payload), 0o755);
    }
    if (moment === "after") expect(() => assertSource(f.job)).toThrow(UpdateError);
    else await expect(verifyCandidate(f.updater.context, f.job, f.metadata)).rejects.toThrow(UpdateError);
    expect(sourceManifest(f.job.candidate).hash).toBe(before.hash);
    if (moment === "before") expect(f.job.commands).toHaveLength(before.commands);
    if (moment === "before") expect(existsSync(join(f.job.directory, "provisioned"))).toBe(false);
    expect(f.job.sourceHash).toBe(moment === "before" ? undefined : before.hash);
    expect(f.job.review).toBeUndefined();
    expect(f.job.history.some(({ phase }) => phase === "ready")).toBe(false);
    const output = join(f.directory, "source-snapshot");
    expect(() => freezeSource(f.job.candidate, output, kind)).toThrow(UpdateError);
    expect(existsSync(output)).toBe(false);
  });
}

test("frozen-input exclusions and fake dependency metadata fail closed", async () => {
  const f = await prepared();
  f.write(join(f.job.directory, "inputs/upstream"), ".omp/SYSTEM.md", "unhashed input instruction\n");
  expect(sourceManifest(join(f.job.directory, "inputs/upstream")).hash).toBe(f.job.inputs!.incoming.hash);
  expect(() => assertFrozen(f.job)).toThrow(UpdateError);
  expect(f.job.sourceHash).toBeUndefined();
  f.write(f.job.candidate, "node_modules", "console.log('not a dependency directory');\n");
  expect(() => sourceManifest(f.job.candidate)).toThrow(UpdateError);
  expect(f.job.review).toBeUndefined();
});

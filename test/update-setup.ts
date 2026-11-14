import { afterEach } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DoriUpdater } from "../src/update/controller.ts";
import { verifyCandidate } from "../src/update/pipeline.ts";
import { prepareCandidate } from "../src/update/prepare.ts";
import { digest, gitIdentity } from "../src/update/source.ts";
import { persistJob, persistState, readState } from "../src/update/state.ts";
import {
  REVIEW_ITEMS,
  type UpdateConfig,
  type UpdateEvent,
  type UpdateJob,
  type UpdateReview,
} from "../src/update/types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    for (const receipt of new Bun.Glob("**/runtime-paths.json").scanSync({
      cwd: path,
      absolute: true,
      dot: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const ownership = JSON.parse(readFileSync(receipt, "utf8")) as { alias: string; directory: string };
      if (
        typeof ownership.alias !== "string" ||
        !/^\/tmp\/du-[a-f0-9]{16}$/.test(ownership.alias) ||
        ownership.directory !== realpathSync(dirname(receipt))
      )
        continue;
      const alias = lstatSync(ownership.alias, { throwIfNoEntry: false });
      if (alias?.isSymbolicLink() && readlinkSync(ownership.alias) === ownership.directory) unlinkSync(ownership.alias);
    }
    rmSync(path, { recursive: true, force: true });
  }
});

export function git(cwd: string, ...argv: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...argv], {
    cwd,
    env: { PATH: process.env["PATH"], HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

export function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dori-update-test-")));
  directories.push(directory);
  const remote = join(directory, "remote");
  const localSource = join(directory, "local");
  mkdirSync(remote);
  mkdirSync(localSource);
  const write = (root: string, path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const root of [remote, localSource]) {
    write(root, "package.json", '{"name":"dori-superagent","type":"module"}\n');
    write(root, "skills/dori-mode/scripts/src/cli.ts", "export const cli = 1;\n");
    write(root, "src/behavior.ts", "export const behavior = 1;\n");
    write(root, "omp-ulw.lock", `${"a".repeat(40)}\n`);
  }
  git(remote, "init", "-b", "main");
  git(remote, "config", "user.name", "Dori updater fixture");
  git(remote, "config", "user.email", "updater@example.invalid");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Dori fixture baseline");
  const baseUpstream = git(remote, "rev-parse", "HEAD");
  const config: UpdateConfig = {
    version: 1,
    target: "dori",
    runtime: "herdr",
    root: join(directory, "updates"),
    remote,
    ref: "refs/heads/main",
    baseUpstream,
    localSource,
    intervalSeconds: 1,
    // A real failing process exercises failure propagation; it never impersonates a successful coding agent.
    worker: { name: "port", argv: ["false", "{prompt}"], timeoutMs: 10_000 },
    reviewer: {
      name: "review",
      argv: ["omp", "-p", "--model", "anthropic/claude-opus-5-5", "{prompt}"],
      timeoutMs: 10_000,
    },
    provision: [],
    checks: [{ name: "types", argv: ["bun", "run", "typecheck"], timeoutMs: 10_000 }],
    modelEnv: [],
    reporterEnv: [],
  };
  const events: UpdateEvent[] = [];
  const updater = new DoriUpdater(config, (event) => events.push(event));
  return { directory, remote, localSource, config, updater, events, write };
}

export type PublicationFixture = {
  readonly directory: string;
  readonly remote: string;
  readonly localSource: string;
  readonly config: UpdateConfig;
  readonly updater: DoriUpdater;
  readonly events: UpdateEvent[];
  readonly write: (root: string, path: string, text: string) => void;
  readonly job: UpdateJob;
  readonly target: string;
  readonly seed: string;
  readonly expectedMain: string;
};

/** Starts the publication consumer at ready. No coding/review agent or remote CI success is impersonated. */
export async function publicationFixture(
  options: (paths: { readonly directory: string; readonly localSource: string }) => Partial<UpdateConfig> = () => ({}),
): Promise<PublicationFixture> {
  const f = fixture();
  f.write(f.localSource, "ref/omp-ulw/library.ts", "export const pinned = true;\n");
  f.write(f.localSource, ".env", "PRIVATE_FIXTURE=never-exported\n");
  f.write(f.localSource, "config.json", '{"privateFixture":"never-exported"}\n');
  f.write(f.remote, "src/behavior.ts", "export const behavior = 2;\n");
  f.write(f.remote, ".gitignore", "node_modules/\nsrc/ignored-adaptation.ts\n");
  f.write(f.remote, "assets/data.bin", "\0public binary fixture\n");
  f.write(f.remote, "scripts/run.sh", "#!/bin/sh\nprintf 'public fixture\\n'\n");
  chmodSync(join(f.remote, "scripts/run.sh"), 0o755);
  git(f.remote, "add", ".");
  git(f.remote, "commit", "-m", "Nonempty fixture upstream update");
  const upstream = git(f.remote, "rev-parse", "HEAD");
  const target = join(f.directory, "publication.git");
  const seed = join(f.directory, "publication-seed");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Publication fixture owner");
  git(seed, "config", "user.email", "owner@example.invalid");
  f.write(seed, "package.json", '{"name":"independent-owner-history","type":"module"}\n');
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Independent owner history");
  for (const path of ["package.json", "skills/dori-mode/scripts/src/cli.ts", "src/behavior.ts", "omp-ulw.lock"]) {
    f.write(seed, path, readFileSync(join(f.localSource, path), "utf8"));
  }
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Preserved owner history");
  git(seed, "clone", "--bare", "--no-local", seed, target);
  const expectedMain = git(target, "rev-parse", "refs/heads/main");
  const config: UpdateConfig = {
    ...f.config,
    provision: [
      {
        name: "install-runtime-fixture",
        argv: [
          process.execPath,
          "-e",
          "await Bun.write('node_modules/private-fixture/data', 'installed runtime fixture must stay private\\n');",
        ],
        timeoutMs: 10_000,
      },
    ],
    checks: [
      {
        name: "verify-behavior",
        argv: [
          process.execPath,
          "-e",
          "import { behavior } from './src/behavior.ts'; if (behavior !== 2) throw new Error('unexpected public behavior');",
        ],
        timeoutMs: 10_000,
      },
    ],
    promotion: {
      publish: {
        remote: target,
        ref: "refs/heads/main",
        author: { name: "Dori publication fixture", email: "publication@example.invalid" },
      },
    },
    ...options(f),
  };
  const updater = new DoriUpdater(config, (event) => f.events.push(event));
  const id = digest(`${updater.context.configHash}\n${upstream}`);
  const directory = join(config.root, "jobs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  const job: UpdateJob = {
    version: 1,
    id,
    upstream,
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
  f.write(job.candidate, "src/ignored-adaptation.ts", "export const ignoredAdaptation = true;\n");
  await verifyCandidate(updater.context, job, gitIdentity(job.candidate));
  job.review = {
    version: 1,
    sourceHash: job.sourceHash!,
    verdict: "approve",
    checklist: Object.fromEntries(
      REVIEW_ITEMS.map((name) => [
        name,
        {
          status: "pass",
          evidence: "Hash-bound approved input to the publication consumer boundary.",
        },
      ]),
    ) as UpdateReview["checklist"],
    findings: [],
    limitations: ["No coding or review agent is invoked by these publication boundary regressions."],
  };
  job.phase = "ready";
  job.history.push({ phase: "ready", at: new Date().toISOString() });
  persistJob(job);
  const state = readState(updater.context);
  state.jobs[upstream] = id;
  state.observed = upstream;
  state.processed = upstream;
  persistState(updater.context, state);
  return { ...f, config, updater, job, target, seed, expectedMain };
}

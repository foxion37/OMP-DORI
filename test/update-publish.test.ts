import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runUpdate } from "../src/update/cli.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { loadUpdateConfig } from "../src/update/load.ts";
import { publicSource } from "../src/update/publish-export.ts";
import { candidateReport } from "../src/update/report.ts";
import { gitIdentity } from "../src/update/source.ts";
import { readState, saveJson } from "../src/update/state.ts";
import { fixture, git, publicationFixture } from "./update-setup.ts";

// Real Git setup and multiple publication passes include fixture subprocesses with 10-second deadlines.
test("public export uses only the checked manifest, preserves modes and independent owner history", async () => {
  const f = await publicationFixture();
  const before = gitIdentity(f.job.candidate);
  const history = structuredClone(f.job.history);
  const commands = structuredClone(f.job.commands);
  const manifest = publicSource(f.job);
  const outcome = await f.updater.once();
  expect(outcome.outcome).toBe("promoted");
  const job = outcome.job!;
  const commit = job.promotion!.publication!.commit!;
  expect(git(f.target, "rev-parse", "main")).toBe(commit);
  expect(git(f.target, "show", "--format=%P", "--no-patch", commit)).toBe(f.expectedMain);
  expect(git(f.target, "rev-list", "--count", "main")).toBe("3");
  expect(git(f.target, "log", "--format=%s", "main")).toContain("Independent owner history");
  const paths = git(f.target, "ls-tree", "-rz", "--name-only", commit).split("\0").filter(Boolean).sort();
  expect(paths).toEqual(manifest.files.map((file) => file.path));
  expect(paths).toContain("omp-ulw.lock");
  expect(paths).toContain(".gitignore");
  expect(paths).toContain("src/ignored-adaptation.ts");
  expect(git(f.target, "show", `${commit}:assets/data.bin`)).toBe("\0public binary fixture");
  expect(
    paths.some(
      (path) =>
        path === ".env" ||
        path === "config.json" ||
        path === "job.json" ||
        path.startsWith("ref/omp-ulw/") ||
        path.startsWith("node_modules/") ||
        path.startsWith(".git/"),
    ),
  ).toBe(false);
  expect(git(f.target, "ls-tree", commit, "scripts/run.sh")).toStartWith("100755 blob ");
  expect(git(f.target, "ls-tree", commit, "src/behavior.ts")).toStartWith("100644 blob ");
  const message = git(f.target, "show", "--format=%B", "--no-patch", commit);
  expect(message).toContain(`Dori-Source-SHA256: ${job.sourceHash}`);
  expect(message).toContain(`Dori-Export-SHA256: ${manifest.hash}`);
  expect(message).toContain(`Upstream-Commit: ${job.upstream}`);
  expect(message).not.toContain(f.directory);
  expect(JSON.parse(readFileSync(join(job.directory, "publication/public-source.json"), "utf8"))).toEqual(manifest);
  expect(gitIdentity(f.job.candidate)).toBe(before);
  expect(job.phase).toBe("ready");
  expect(job.history).toEqual(history);
  expect(job.commands).toEqual(commands);
  expect(readState(f.updater.context).baseline).toBe(job.upstream);
  expect(f.updater.context.config.baseUpstream).toBe(f.config.baseUpstream);
  const report = candidateReport(f.updater.context, job);
  expect(report).toMatchObject({
    ready: true,
    candidateOnly: false,
    published: true,
    deployed: false,
    activationRequiresNewOwnerApproval: false,
  });
  expect((await new DoriUpdater(f.config, () => {}).once()).outcome).toBe("duplicate");
  expect(git(f.target, "rev-list", "--count", "main")).toBe("3");
  const config = join(f.directory, "updater.json");
  saveJson(config, f.config);
  expect(await runUpdate(["check", "--config", config])).toBe(0);
}, 30_000);

test("the next detected candidate uses the persisted successful baseline while configured base remains unchanged", async () => {
  const f = await publicationFixture();
  expect((await f.updater.once()).outcome).toBe("promoted");
  const published = git(f.target, "rev-parse", "main");
  f.write(f.remote, "src/behavior.ts", "export const behavior = 3;\n");
  git(f.remote, "add", ".");
  git(f.remote, "commit", "-m", "Next real upstream change");
  const next = await new DoriUpdater(f.config, () => {}).once();
  expect(next.job?.baseUpstream).toBe(f.job.upstream);
  expect(next.job?.inputs?.baseUpstream).toBe(f.job.upstream);
  expect(readFileSync(join(next.job!.directory, "inputs/base/src/behavior.ts"), "utf8")).toBe(
    "export const behavior = 2;\n",
  );
  expect(next.job?.phase).toBe("failed"); // The configured real failing port process is never replaced with a fake agent.
  expect(readState(f.updater.context).baseline).toBe(f.job.upstream);
  expect(f.updater.context.config.baseUpstream).toBe(f.config.baseUpstream);
  expect(git(f.target, "rev-parse", "main")).toBe(published);
});

test.each(["bytes", "mode"] as const)(
  "changed checked %s hold promotion without rewriting ready or its baseline",
  async (kind) => {
    const f = await publicationFixture();
    const originalHash = f.job.sourceHash;
    const commands = structuredClone(f.job.commands);
    if (kind === "bytes") f.write(f.job.candidate, "src/behavior.ts", "export const behavior = 9;\n");
    else chmodSync(join(f.job.candidate, "scripts/run.sh"), 0o644);
    const result = await f.updater.once();
    expect(result.outcome).toBe("held");
    expect(result.job?.phase).toBe("ready");
    expect(result.job?.sourceHash).toBe(originalHash);
    expect(result.job?.commands).toEqual(commands);
    expect(result.job?.promotion?.status).toBe("held");
    expect(readState(f.updater.context).baseline).toBeUndefined();
    expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    expect(git(f.target, "for-each-ref", "--format=%(refname)", "refs/heads/dori-update/")).toBe("");
    expect(candidateReport(f.updater.context, result.job!)).toMatchObject({
      ready: false,
      published: false,
      sourceCurrent: false,
    });
  },
);

test("promotion is optional and lexical source identity survives a legitimate release symlink switch", () => {
  const f = fixture();
  const alias = join(f.directory, "local-source");
  symlinkSync(f.localSource, alias);
  const file = join(f.directory, "updater.json");
  saveJson(file, { ...f.config, localSource: alias });
  const first = loadUpdateConfig(file);
  expect(first.promotion).toBeUndefined();
  expect(first.localSource).toBe(alias);
  const hash = new DoriUpdater(first).context.configHash;
  const release = join(f.directory, "next-release");
  mkdirSync(release);
  unlinkSync(alias);
  symlinkSync(release, alias);
  expect(new DoriUpdater(loadUpdateConfig(file)).context.configHash).toBe(hash);
  expect(loadUpdateConfig(file).localSource).toBe(alias);
});

test("a forged ported manifest cannot export candidate Git metadata while the checked source stays unchanged", async () => {
  const f = await publicationFixture();
  const path = join(f.job.directory, "ported-source.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.files.push({ path: ".git/config", sha256: "0".repeat(64), executable: false });
  saveJson(path, manifest);
  const result = await f.updater.once();
  expect(result.outcome).toBe("held");
  expect(result.job?.phase).toBe("ready");
  expect(result.job?.sourceHash).toBe(f.job.sourceHash);
  expect(result.job?.promotion?.publication).toBeUndefined();
  expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
  expect(readState(f.updater.context).baseline).toBeUndefined();
  expect(candidateReport(f.updater.context, result.job!)).toMatchObject({
    ready: true,
    published: false,
    sourceCurrent: true,
  });
});

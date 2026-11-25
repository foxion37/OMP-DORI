import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumerPaths } from "../src/release/files.ts";
import { ownReleaseRoot, saveDeploymentJson } from "../src/update/deployment-files.ts";
import { DeploymentHeld } from "../src/update/deployment-process.ts";
import { sourceManifest } from "../src/update/source.ts";
import { sourceCandidate } from "../src/update/source-update-candidate.ts";
import { currentSource } from "../src/update/source-update-git.ts";
import { git } from "./update-setup.ts";
import { gitSourceFixture } from "./update-source-git-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

linux("actual source check selects a trusted main commit without acquiring ownership or preparing it", async () => {
  const f = await gitSourceFixture();
  const before = sourceManifest(f.source);
  const result = await f.cli("update", "source", "check");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toMatchObject({
    mode: "source",
    status: "available",
    current: f.current.commit,
    commit: f.target.commit,
    ci: f.target.ci,
  });
  expect(sourceManifest(f.source)).toEqual(before);
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
  expect(
    f.readRequests().every((request) => request.home === f.config.credentialHome && request.leaked.length === 0),
  ).toBe(true);
  expect(f.readRequests().every((request) => request.argv[1]?.startsWith("repos/vntrevx/Cataly"))).toBe(true);
  const status = await f.cli("update", "source", "status");
  expect(status).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(status.stdout)).toMatchObject({ mode: "source", lastAttempt: null });
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
});

linux("a source candidate is a real immutable-target clone and a clean interrupted clone is reusable", async () => {
  const f = await gitSourceFixture();
  ownReleaseRoot(f.config.deployment);
  const input = await sourceCandidate(f.config, f.target);
  expect(git(input.candidate, "rev-parse", "HEAD")).toBe(f.target.commit);
  expect(git(input.candidate, "rev-parse", "HEAD^{tree}")).toBe(f.target.tree);
  expect(input.publicManifest.hash).toBe(sourceManifest(input.candidate).hash);
  expect(input.publicManifest.files.some((file) => file.path.includes("node_modules"))).toBe(false);
  expect(await sourceCandidate(f.config, f.target)).toEqual(input);
  expect(await currentSource(f.config)).toEqual(f.current);
  expect(readFileSync(join(f.source, "src/app.ts"), "utf8")).toContain("published");
});

linux.each(["tracked", "untracked"] as const)(
  "local %s source changes are held without being overwritten",
  async (kind) => {
    const f = await gitSourceFixture();
    const path = join(f.source, kind === "tracked" ? "src/app.ts" : "local-work.ts");
    writeFileSync(path, "export const ownerWork = true;\n");
    await expect(currentSource(f.config)).rejects.toThrow("source checkout has local changes");
    const result = await f.cli("update", "source", "check");
    expect(result.code).toBe(4);
    expect(readFileSync(path, "utf8")).toBe("export const ownerWork = true;\n");
    expect(existsSync(f.requests)).toBe(false);
    expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
  },
);

linux("a linked-worktree Git file is rejected before executing Git or GitHub", async () => {
  const f = await gitSourceFixture();
  renameSync(join(f.source, ".git"), join(f.root, "detached-git"));
  writeFileSync(join(f.source, ".git"), `gitdir: ${join(f.root, "detached-git")}\n`);
  await expect(currentSource(f.config)).rejects.toThrow("ordinary Git checkout");
  expect(existsSync(f.requests)).toBe(false);
});

linux("consumer installation state fences the source command", async () => {
  const f = await gitSourceFixture();
  const paths = consumerPaths(f.config.deployment.home, f.config.deployment.catalyHome);
  saveDeploymentJson(paths.state, { version: 1 });
  await expect(currentSource(f.config)).rejects.toThrow("consumer installation");
  expect(existsSync(f.requests)).toBe(false);
});

linux.each(["dirty", "wrong-tree"] as const)(
  "an existing %s candidate cannot cross the preparation boundary",
  async (kind) => {
    const f = await gitSourceFixture();
    ownReleaseRoot(f.config.deployment);
    const input = await sourceCandidate(f.config, f.target);
    if (kind === "dirty") writeFileSync(join(input.candidate, "src/app.ts"), "export const tampered = true;\n");
    const target = kind === "wrong-tree" ? { ...f.target, tree: "f".repeat(40) } : f.target;
    await expect(sourceCandidate(f.config, target)).rejects.toBeInstanceOf(DeploymentHeld);
    expect(await currentSource(f.config)).toEqual(f.current);
  },
);

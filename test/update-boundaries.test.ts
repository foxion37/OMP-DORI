import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { loadUpdateConfig } from "../src/update/load.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { isolatedEnv } from "../src/update/environment.ts";
import { restoreUpdate, snapshotUpdate } from "../src/update/recovery.ts";
import { candidateReport } from "../src/update/report.ts";
import { parseReview, readPortResult } from "../src/update/review.ts";
import { assertDoriScope, assertSource, sourceManifest } from "../src/update/source.ts";
import { REVIEW_ITEMS } from "../src/update/types.ts";
import { fixture, git } from "./update-setup.ts";

const hash = "a".repeat(64);
const structuredReview = () => ({
  version: 1,
  sourceHash: hash,
  verdict: "approve",
  checklist: Object.fromEntries(
    REVIEW_ITEMS.map((name) => [name, { status: "pass", evidence: `evidence for ${name}` }]),
  ),
  findings: [],
  limitations: ["Environment/path isolation is not an OS sandbox."],
});
const line = (value: unknown) => `DORI_UPDATE_REVIEW ${JSON.stringify(value)}`;

describe("Dori candidate boundaries", () => {
  test("review parser requires exact source, all eight evidenced items, limits and one unambiguous verdict", () => {
    expect(parseReview(line(structuredReview()), hash).verdict).toBe("approve");
    expect(() => parseReview(line(structuredReview()), "b".repeat(64))).toThrow("stale source");
    expect(() => parseReview("VERDICT: CLEAR", hash)).toThrow("structured verdict");
    expect(() => parseReview(`${line(structuredReview())}\n${line(structuredReview())}`, hash)).toThrow("exactly one");
    expect(() =>
      parseReview(`quoted example:\n${line(structuredReview())}\nactual verdict is rejection`, hash),
    ).toThrow("exactly one");
    expect(() => parseReview(`\u0060\u0060\u0060json\n${line(structuredReview())}\n\u0060\u0060\u0060`, hash)).toThrow(
      "exactly one",
    );
    const partial = structuredReview();
    delete partial.checklist["scope"];
    expect(() => parseReview(line(partial), hash)).toThrow("eight");
    const unknown = structuredReview();
    unknown.checklist["verification"]!.status = "unknown";
    expect(() => parseReview(line(unknown), hash)).toThrow("unknown checklist");
    const noLimits = { ...structuredReview(), limitations: [] };
    expect(() => parseReview(line(noLimits), hash)).toThrow("limitations");
    expect(parseReview(line({ ...unknown, verdict: "reject" }), hash).verdict).toBe("reject");
  });

  test("changed code and ULW drift invalidate source binding; missing check evidence never becomes ready", async () => {
    const f = fixture();
    const job = (await f.updater.once("stage")).job!;
    job.sourceHash = sourceManifest(job.candidate).hash;
    expect(() => assertSource(job)).not.toThrow();
    f.write(job.candidate, "src/new-file.ts", "export const newFile = true;\n");
    expect(() => assertSource(job)).toThrow("stale");
    f.write(job.candidate, "omp-ulw.lock", `${"b".repeat(40)}\n`);
    expect(() => assertDoriScope(job.inputs!, sourceManifest(job.candidate))).toThrow("ULW lock/library");
    job.phase = "ready";
    expect(() => candidateReport(f.updater.context, job)).toThrow("lacks passed checks");
  });

  test("opaque local ULW source is admitted, carried, covered and recovered; mutations and unseen installs hold", async () => {
    const f = fixture();
    const libraryFile = "ref/omp-ulw/runtime.ts";
    const bytes = "export const pinnedRuntime = 'unchanged';\n";
    f.write(f.localSource, libraryFile, bytes);
    const excluded = [
      "ref/omp-ulw/.git/config",
      "ref/omp-ulw/node_modules/private/index.js",
      "ref/omp-ulw/auth/token.json",
    ];
    for (const path of excluded) f.write(f.localSource, path, "must not enter the candidate\n");
    const job = (await f.updater.once("stage")).job!;
    expect(job.inputs!.local.ulwPresent).toBe(true);
    expect(job.inputs!.local.files.some((file) => file.path === libraryFile)).toBe(true);
    expect(job.inputs!.changedPaths).toContain(libraryFile);
    expect(job.inputs!.changedPaths).toContain("ref/omp-ulw/");
    expect(readFileSync(join(job.candidate, libraryFile), "utf8")).toBe(bytes);
    expect(readFileSync(join(job.directory, "inputs/local", libraryFile), "utf8")).toBe(bytes);
    for (const path of excluded) {
      expect(existsSync(join(job.candidate, path))).toBe(false);
      expect(existsSync(join(job.directory, "inputs/local", path))).toBe(false);
    }
    expect(() => assertDoriScope(job.inputs!, sourceManifest(job.candidate))).not.toThrow();
    job.sourceHash = sourceManifest(job.candidate).hash;
    expect(() => assertSource(job)).not.toThrow();
    writeFileSync(
      join(job.directory, "port-result.json"),
      JSON.stringify({
        version: 1,
        baseHash: job.inputs!.base.hash,
        localHash: job.inputs!.local.hash,
        upstreamHash: job.inputs!.incoming.hash,
        coverage: job
          .inputs!.changedPaths.filter((path) => path !== libraryFile)
          .map((path) => ({ path, disposition: "preserved", evidence: "frozen identity" })),
      }),
    );
    expect(() => readPortResult(job)).toThrow("every upstream and local changed path");
    const snapshot = snapshotUpdate(f.updater.context, job.id, join(f.directory, "library-snapshot"));
    const restored = restoreUpdate(f.updater.context, snapshot, join(f.directory, "library-restored"));
    expect(readFileSync(join(restored, "candidate", libraryFile), "utf8")).toBe(bytes);
    expect(sourceManifest(join(restored, "candidate")).hash).toBe(job.sourceHash);
    f.write(job.candidate, libraryFile, "export const pinnedRuntime = 'changed';\n");
    expect(() => assertSource(job)).toThrow("stale");
    expect(() => assertDoriScope(job.inputs!, sourceManifest(job.candidate))).toThrow("ULW lock/library");

    const absent = fixture();
    const withoutLibrary = (await absent.updater.once("stage")).job!;
    expect(withoutLibrary.inputs!.local.ulwPresent).toBe(false);
    expect(existsSync(join(withoutLibrary.candidate, "ref/omp-ulw"))).toBe(false);
    withoutLibrary.sourceHash = sourceManifest(withoutLibrary.candidate).hash;
    mkdirSync(join(withoutLibrary.candidate, "ref/omp-ulw"), { recursive: true });
    expect(() => assertSource(withoutLibrary)).toThrow("stale");
    expect(() => assertDoriScope(withoutLibrary.inputs!, sourceManifest(withoutLibrary.candidate))).toThrow(
      "ULW lock/library",
    );
  });

  test("port coverage rejects missing/duplicate input paths rather than accepting a worker success claim", async () => {
    const f = fixture();
    f.write(f.localSource, "src/new-adaptation.ts", "export const adaptation = true;\n");
    const job = (await f.updater.once("stage")).job!;
    const receipt = {
      version: 1,
      baseHash: job.inputs!.base.hash,
      localHash: job.inputs!.local.hash,
      upstreamHash: job.inputs!.incoming.hash,
      coverage: [],
    };
    writeFileSync(join(job.directory, "port-result.json"), JSON.stringify(receipt));
    expect(() => readPortResult(job)).toThrow("every upstream and local changed path");
    const coverage = job.inputs!.changedPaths.map((path) => ({
      path,
      disposition: "adapted",
      evidence: "implementation evidence",
    }));
    writeFileSync(
      join(job.directory, "port-result.json"),
      JSON.stringify({ ...receipt, coverage: [...coverage, ...coverage] }),
    );
    expect(() => readPortResult(job)).toThrow("exactly once");
  });

  test("model capability is separated from checks and parent pane/config identities; links fail before source admission", () => {
    const f = fixture();
    const oldSecret = process.env["UPDATER_FIXTURE_SECRET"];
    const oldPane = process.env["HERDR_PANE_ID"];
    process.env["UPDATER_FIXTURE_SECRET"] = "fixture-secret-value";
    process.env["HERDR_PANE_ID"] = "parent-pane";
    try {
      const updater = new DoriUpdater({ ...f.config, modelEnv: ["UPDATER_FIXTURE_SECRET"] });
      const model = isolatedEnv(updater.context, join(f.directory, "model-runtime"), "model");
      const check = isolatedEnv(updater.context, join(f.directory, "check-runtime"), "check");
      expect(model["UPDATER_FIXTURE_SECRET"]).toBe("fixture-secret-value");
      expect(check["UPDATER_FIXTURE_SECRET"]).toBeUndefined();
      expect(model["HERDR_PANE_ID"]).toBeUndefined();
      expect(model["HC_TERMINAL_ID"]).toBeUndefined();
      expect(model["DORI_RUNTIME"]).toBe("herdr");
      expect(check["DORI_TELEMETRY"]).toBe("0");
      expect(check["DO_NOT_TRACK"]).toBe("1");
      expect(model["HOME"]).not.toBe(check["HOME"]);
      expect(model["PI_CODING_AGENT_DIR"]).not.toBe(check["PI_CODING_AGENT_DIR"]);
      symlinkSync(join(f.directory, "outside-secret"), join(f.localSource, "leak"));
      expect(() => sourceManifest(f.localSource)).toThrow("link or special file");
    } finally {
      if (oldSecret === undefined) delete process.env["UPDATER_FIXTURE_SECRET"];
      else process.env["UPDATER_FIXTURE_SECRET"] = oldSecret;
      if (oldPane === undefined) delete process.env["HERDR_PANE_ID"];
      else process.env["HERDR_PANE_ID"] = oldPane;
    }
  });

  test("deep durable runtimes use short owned socket paths and refuse alias collisions", async () => {
    const f = fixture();
    const directory = join(f.directory, "deep-job-runtime-".repeat(10), "000");
    const cache = join(f.directory, "shared-cache");
    const env = isolatedEnv(f.updater.context, directory, "check", cache);
    const alias = dirname(env["HOME"]!);
    expect(realpathSync(alias)).toBe(realpathSync(directory));
    expect(realpathSync(env["XDG_CACHE_HOME"]!)).toBe(realpathSync(cache));
    expect(realpathSync(env["XDG_RUNTIME_DIR"]!)).toBe(join(realpathSync(directory), "run"));
    expect(isolatedEnv(f.updater.context, directory, "check", cache)["HOME"]).toBe(env["HOME"]);
    const socket = join(env["XDG_CONFIG_HOME"]!, "herdr", "sessions", "runtime-fixture", "herdr.sock");
    expect(Buffer.byteLength(socket)).toBeLessThan(100);
    mkdirSync(dirname(socket), { recursive: true });
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }
    unlinkSync(alias);
    symlinkSync(f.localSource, alias, "dir");
    try {
      expect(() => isolatedEnv(f.updater.context, directory, "check", cache)).toThrow("alias collision");
      expect(realpathSync(alias)).toBe(realpathSync(f.localSource));
    } finally {
      unlinkSync(alias);
    }
  });

  test("runtime Git discovery stops at the real sandbox boundary through its short alias", () => {
    const f = fixture();
    const directory = join(f.remote, "jobs", "runtime", "000");
    const env = isolatedEnv(f.updater.context, directory, "check");
    const tmp = env["TMPDIR"]!;
    expect(git(tmp, "rev-parse", "--show-toplevel")).toBe(realpathSync(f.remote));
    const discover = (cwd: string) =>
      Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const outside = discover(tmp);
    expect(outside.exitCode).toBe(128);
    const nested = join(tmp, "nested");
    const subdirectory = join(nested, "subdirectory");
    mkdirSync(subdirectory, { recursive: true });
    git(nested, "init", "-b", "main");
    const inside = discover(subdirectory);
    expect(inside.exitCode).toBe(0);
    expect(inside.stdout.toString().trim()).toBe(realpathSync(nested));
  });

  test("dedicated config rejects live/source overlap, absent real checks, resume and reporter path interpolation", () => {
    const f = fixture();
    const path = join(f.directory, "update.json");
    const load = (patch: Record<string, unknown>) => {
      writeFileSync(path, JSON.stringify({ ...f.config, ...patch }));
      return () => loadUpdateConfig(path);
    };
    expect(load({ root: join(f.localSource, "state") })).toThrow("nonoverlapping");
    expect(load({ checks: [] })).toThrow("actual verification");
    expect(load({ worker: { ...f.config.worker, argv: ["omp", "--resume", "{prompt}"] } })).toThrow("fresh process");
    expect(load({ reporter: { name: "notify", argv: ["notify", "{text}", "{candidate}"], timeoutMs: 1000 } })).toThrow(
      "may use only",
    );
    expect(load({ runtime: "hc" })).toThrow('runtime:"herdr"');
  });
});

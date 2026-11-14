import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "../src/update/config.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { pendingPromotion } from "../src/update/promotion.ts";
import { PublicationProcess } from "../src/update/publish-process.ts";
import { reportCandidate } from "../src/update/report.ts";
import { persistJob, readJob, readState } from "../src/update/state.ts";
import { git, type PublicationFixture, publicationFixture } from "./update-setup.ts";

type WaitMode = "blocked" | "missing" | "pending" | "unavailable" | "legacy";
const REMOTE = "https://github.com/owner/repo.git";

function githubBoundary(f: PublicationFixture, mode: WaitMode) {
  const originalGit = PublicationProcess.prototype.git;
  // Git storage and pushes are real and local; only GitHub transport/API observations are simulated.
  const transport = spyOn(PublicationProcess.prototype, "git").mockImplementation(function (
    this: PublicationProcess,
    argv,
    input,
    auth,
    env,
  ) {
    return originalGit.call(
      this,
      argv.map((arg) => (arg === REMOTE ? f.target : arg)),
      input,
      auth,
      env,
    );
  });
  const api = spyOn(PublicationProcess.prototype, "api").mockImplementation(async (path) => {
    if (mode === "unavailable") throw new UpdateError("transient GitHub readback failure");
    const record = readJob(f.config.root, f.job.id).promotion!.publication!;
    if (path.startsWith("repos/owner/repo/pulls?")) {
      return [{ number: 7, head: { ref: record.branch.slice("refs/heads/".length) } }];
    }
    if (path === "repos/owner/repo/pulls/7") {
      return {
        state: "open",
        draft: false,
        head: { sha: record.commit, repo: { full_name: "owner/repo" } },
        base: { sha: record.expectedMain, ref: "main", repo: { full_name: "owner/repo" } },
        requested_reviewers: [],
        requested_teams: [],
        mergeable: true,
        mergeable_state: mode === "blocked" || mode === "legacy" ? "blocked" : "clean",
      };
    }
    if (path === "repos/owner/repo/branches/main") return { protected: false, commit: { sha: record.expectedMain } };
    if (path === "repos/owner/repo/rules/branches/main") return [];
    if (path.startsWith(`repos/owner/repo/commits/${record.commit}/check-runs?`)) {
      return {
        check_runs:
          mode === "missing"
            ? []
            : [
                {
                  id: 1,
                  head_sha: record.commit,
                  name: "types",
                  status: mode === "pending" ? "in_progress" : "completed",
                  conclusion: mode === "pending" ? null : "success",
                  app: { id: 1 },
                },
              ],
      };
    }
    if (path.startsWith(`repos/owner/repo/commits/${record.commit}/status?`))
      return { sha: record.commit, statuses: [] };
    throw new Error(`Unexpected GitHub fixture request: ${path}`);
  });
  return { transport, api };
}

// Several real Git/detector cycles can outlast Bun's default 5s; keep their test-local budget bounded.
test.each(["blocked", "missing", "pending", "unavailable", "legacy"] as const)(
  "a %s exact-head CI wait retains its first deadline, holds once and releases newer detection",
  async (mode) => {
    const f = await publicationFixture(({ directory }) => ({
      checks: [
        {
          name: "verify-behavior",
          argv: [
            process.execPath,
            "-e",
            "import { behavior } from './src/behavior.ts'; if (behavior !== 2) throw new Error('unexpected behavior');",
          ],
          timeoutMs: mode === "pending" ? 7_200_000 : mode === "unavailable" ? 172_800_000 : 10_000,
        },
        ...(mode === "pending"
          ? [
              {
                name: "verify-adaptation",
                argv: [
                  process.execPath,
                  "-e",
                  "import { ignoredAdaptation } from './src/ignored-adaptation.ts'; if (!ignoredAdaptation) process.exit(1);",
                ],
                timeoutMs: 7_200_000,
              },
            ]
          : []),
      ],
      promotion: {
        publish: {
          remote: REMOTE,
          ref: "refs/heads/main",
          author: { name: "CI waiting fixture", email: "waiting@example.invalid" },
          github: { gh: process.execPath, credentialHome: directory, requiredChecks: ["types"] },
        },
      },
      reporter: {
        name: "notify",
        argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]);", "{text}"],
        timeoutMs: 10_000,
      },
    }));
    const commands = structuredClone(f.job.commands);
    const boundary = githubBoundary(f, mode);
    const originalNow = Date.now;
    const clock = spyOn(Date, "now");
    try {
      const first = (await f.updater.once()).job!;
      const waiting = first.promotion!.publication!;
      let window = waiting.ciWait!;
      expect(first.promotion?.status).toBe("publishing");
      expect(waiting.status).toBe("awaiting-ci");
      expect(waiting.ci).toBeUndefined();
      expect(first.notification).toBeUndefined();
      expect(first.commands).toEqual(commands);
      const timeout = mode === "pending" ? 14_400_000 : mode === "unavailable" ? 86_400_000 : 3_600_000;
      expect(Date.parse(window.deadlineAt) - Date.parse(window.startedAt)).toBe(timeout);
      expect(pendingPromotion(f.updater.context, readState(f.updater.context))?.id).toBe(f.job.id);
      if (mode === "legacy") {
        const legacy = { ...waiting, updatedAt: new Date(Date.parse(window.startedAt) + timeout / 2).toISOString() };
        delete legacy.ciWait;
        first.promotion!.publication = legacy;
        persistJob(first);
        window = {
          startedAt: legacy.createdAt,
          deadlineAt: new Date(Date.parse(legacy.createdAt) + timeout).toISOString(),
        };
      }
      clock.mockReturnValue(Date.parse(window.startedAt) + timeout / 2);
      const resumed = (await new DoriUpdater(f.config, (event) => f.events.push(event)).once()).job!;
      expect(resumed.promotion?.publication?.ciWait).toEqual(window);
      expect(resumed.promotion?.publication?.status).toBe("awaiting-ci");
      expect(resumed.promotion?.status).toBe("publishing");
      expect(resumed.commands).toEqual(commands);
      expect(resumed.review).toEqual(f.job.review);
      expect(resumed.history).toEqual(f.job.history);
      expect(resumed.sourceHash).toBe(f.job.sourceHash);
      expect(f.events.some((event) => event.event === "promotion-held")).toBe(false);
      const apiReads = boundary.api.mock.calls.length;
      const gitOperations = boundary.transport.mock.calls.length;
      clock.mockReturnValue(Date.parse(window.deadlineAt));
      const expired = await new DoriUpdater(f.config, (event) => f.events.push(event)).once();
      const held = expired.job!;
      expect(expired.outcome).toBe("held");
      expect(held.promotion).toMatchObject({
        status: "held",
        publication: { status: "held", ciWait: window },
        notifications: { "promotion-held": { state: "sent", exitCode: 0 } },
      });
      expect(held.promotion?.problem).toContain("deadline expired");
      expect(held.promotion?.publication?.ci).toBeUndefined();
      expect(boundary.api.mock.calls).toHaveLength(apiReads);
      expect(boundary.transport.mock.calls).toHaveLength(gitOperations);
      expect(held.phase).toBe("ready");
      expect(held.sourceHash).toBe(f.job.sourceHash);
      expect(held.history).toEqual(f.job.history);
      expect(held.review).toEqual(f.job.review);
      expect(held.commands.filter((receipt) => receipt.name !== "notify")).toEqual(commands);
      const notifications = held.commands.filter((receipt) => receipt.name === "notify");
      expect(notifications).toHaveLength(1);
      expect(JSON.parse(readFileSync(notifications[0]!.stdout, "utf8"))).toMatchObject({
        outcome: "promotion-held",
        publicationStatus: "held",
        publicationDeadline: window.deadlineAt,
      });
      await reportCandidate(f.updater.context, readJob(f.config.root, f.job.id));
      expect(f.events.filter((event) => event.event === "promotion-held")).toHaveLength(1);
      expect(pendingPromotion(f.updater.context, readState(f.updater.context))).toBeUndefined();
      expect(readState(f.updater.context).active).toBeUndefined();
      expect(readState(f.updater.context).baseline).toBeUndefined();
      clock.mockImplementation(originalNow);
      const retained = readFileSync(join(f.job.directory, "job.json"), "utf8");
      for (let cycle = 0; cycle < 2; cycle++) {
        expect((await new DoriUpdater(f.config, () => {}).once()).outcome).toBe("duplicate");
        expect(readFileSync(join(f.job.directory, "job.json"), "utf8")).toBe(retained);
      }
      f.write(f.remote, "src/behavior.ts", "export const behavior = 3;\n");
      git(f.remote, "add", ".");
      git(f.remote, "commit", "-m", "New upstream after expired publication CI wait");
      const upstream = git(f.remote, "rev-parse", "HEAD");
      const next = await new DoriUpdater(f.config, () => {}).once();
      expect(next.job?.upstream).toBe(upstream);
      expect(next.job?.id).not.toBe(f.job.id);
      expect(next.job?.phase).toBe("failed");
      expect(readState(f.updater.context).observed).toBe(upstream);
      expect(readFileSync(join(f.job.directory, "job.json"), "utf8")).toBe(retained);
      expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
      expect(git(f.target, "rev-parse", waiting.branch)).toBe(waiting.commit!);
    } finally {
      clock.mockRestore();
      boundary.api.mockRestore();
      boundary.transport.mockRestore();
    }
  },
  30_000,
);

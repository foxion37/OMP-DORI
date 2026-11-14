import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DoriUpdater } from "../src/update/controller.ts";
import { reportPreAction } from "../src/update/pre-action-notice.ts";
import { publishRelease } from "../src/update/publish.ts";
import { reportCandidate } from "../src/update/report.ts";
import { persistJob, readJob, readState } from "../src/update/state.ts";
import { type RecordingReporter, recordingReporter, waitFor } from "./update-pre-action-setup.ts";
import { git, publicationFixture } from "./update-setup.ts";

test("configured promotion awaits delivery before main changes and preserves its receipt through the terminal report", async () => {
  let sink!: RecordingReporter;
  const f = await publicationFixture(({ directory }) => {
    sink = recordingReporter(directory);
    return { reporter: sink.command };
  });
  const pending = f.updater.once();
  try {
    await waitFor(() => existsSync(sink.started));
    const sending = readJob(f.config.root, f.job.id);
    expect(sending.preActionNotices?.["main-publication"]?.state).toBe("sending");
    expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    expect(sink.delivered()).toEqual([]);
    const publicationCommit = sending.promotion!.publication!.commit!;
    expect(sink.attempts()).toMatchObject([{ publicationCommit, job: f.job.id, outcome: "before-main-publication" }]);
    sink.release();
    const result = await pending;
    expect(result.outcome).toBe("promoted");
    expect(git(f.target, "rev-parse", "main")).toBe(publicationCommit);
    const receipt = structuredClone(result.job!.preActionNotices!["main-publication"]!);
    expect(receipt).toMatchObject({ job: f.job.id, action: "main-publication", state: "accepted", exitCode: 0 });
    expect(result.job!.commands[receipt.commandIndex]).toMatchObject({ exitCode: 0, sourceHash: f.job.sourceHash });
    expect(sink.delivered().map((notice) => notice["outcome"])).toEqual(["before-main-publication", "promoted"]);
    await reportCandidate(f.updater.context, readJob(f.config.root, f.job.id));
    expect(readJob(f.config.root, f.job.id).preActionNotices!["main-publication"]).toEqual(receipt);
    expect(sink.attempts()).toHaveLength(1);
    expect(sink.delivered()).toHaveLength(2);
  } finally {
    sink.release();
    await pending;
  }
}, 30_000);

test.each(["accepted", "sending", "missing-exit", "different-intent"] as const)(
  "publication resume consumes only a complete bound notice without resending: %s",
  async (mode) => {
    let sink!: RecordingReporter;
    const f = await publicationFixture(({ directory }) => {
      sink = recordingReporter(directory);
      sink.release();
      return { reporter: sink.command };
    });
    const interrupted = new Error("interrupt after accepted notice and before main push");
    let crashed = false;
    await expect(
      publishRelease(
        f.updater.context,
        readState(f.updater.context),
        f.job,
        undefined,
        (publication) => {
          f.job.promotion = { version: 1, status: "publishing", publication: structuredClone(publication) };
          persistJob(f.job);
          if (publication.status === "main-pushing" && !crashed) {
            crashed = true;
            throw interrupted;
          }
        },
        (publication) => reportPreAction(f.updater.context, f.job, { action: "main-publication", publication }),
      ),
    ).rejects.toBe(interrupted);
    expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    const retained = readJob(f.config.root, f.job.id);
    const delivery = retained.preActionNotices!["main-publication"]!;
    expect(delivery.state).toBe("accepted");
    if (mode === "sending") delivery.state = "sending";
    if (mode === "missing-exit") delete retained.commands[delivery.commandIndex]!.exitCode;
    if (mode === "different-intent") {
      retained.preActionNotices!["main-publication"] = { ...delivery, intentHash: "0".repeat(64) };
    }
    persistJob(retained);
    const result = await new DoriUpdater(f.config, () => {}).once();
    expect(result.outcome).toBe(mode === "accepted" ? "promoted" : "held");
    expect(git(f.target, "rev-parse", "main")).toBe(
      mode === "accepted" ? retained.promotion!.publication!.commit! : f.expectedMain,
    );
    expect(sink.attempts()).toHaveLength(1);
    if (mode === "sending") expect(result.job!.preActionNotices!["main-publication"]!.state).toBe("ambiguous");
    expect(result.job!.phase).toBe("ready");
    expect(result.job!.notification).toEqual({ state: "sent", exitCode: 0 });
  },
  30_000,
);

test.each(["failed", "ambiguous"] as const)(
  "a %s publication notice retains main and stays held after promotion is resumed",
  async (mode) => {
    let sink!: RecordingReporter;
    const f = await publicationFixture(({ directory }) => {
      sink = recordingReporter(directory, mode);
      return { reporter: sink.command };
    });
    const first = await f.updater.once();
    expect(first.outcome).toBe("held");
    expect(first.job!.preActionNotices!["main-publication"]!.state).toBe(mode);
    expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    expect(sink.attempts()).toHaveLength(1);
    const resumed = readJob(f.config.root, f.job.id);
    resumed.promotion!.status = "publishing";
    resumed.promotion!.publication!.status = "awaiting-ci";
    persistJob(resumed);
    const repeated = await new DoriUpdater(f.config, () => {}).once();
    expect(repeated.outcome).toBe("held");
    expect(repeated.job!.preActionNotices!["main-publication"]!.state).toBe(mode);
    expect(git(f.target, "rev-parse", "main")).toBe(f.expectedMain);
    expect(sink.attempts()).toHaveLength(1);
    expect(sink.delivered().map((notice) => notice["outcome"])).toEqual(["promotion-held"]);
    expect(repeated.job!.notification).toEqual({ state: "sent", exitCode: 0 });
    expect(readState(f.updater.context).baseline).toBeUndefined();
  },
  30_000,
);

test("a main change while the notice is in flight still holds the fast-forward publication", async () => {
  let sink!: RecordingReporter;
  const f = await publicationFixture(({ directory }) => {
    sink = recordingReporter(directory);
    return { reporter: sink.command };
  });
  const pending = f.updater.once();
  try {
    await waitFor(() => existsSync(sink.started));
    f.write(f.seed, "owner-followup.txt", "owner changed main during notification delivery\n");
    git(f.seed, "add", ".");
    git(f.seed, "commit", "-m", "Owner movement during notification");
    git(f.seed, "push", f.target, "HEAD:refs/heads/main");
    const owner = git(f.target, "rev-parse", "main");
    sink.release();
    expect((await pending).outcome).toBe("held");
    expect(git(f.target, "rev-parse", "main")).toBe(owner);
    expect(sink.attempts()).toHaveLength(1);
    expect(readState(f.updater.context).baseline).toBeUndefined();
  } finally {
    sink.release();
    await pending;
  }
}, 30_000);

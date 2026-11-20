import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { ToolError } from "../../../../src/runtime/exec.ts";
import { HcError, isReportedKind } from "../../../../src/runtime/hc/exec.ts";
import { type CreateSpec, formatRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { quoteForPane } from "./launch-footer.ts";
import {
  discardGeneratedBrief,
  type GeneratedBrief,
  publishGeneratedBrief,
  stageGeneratedBrief,
} from "./launch-generated.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { placementFields } from "./placement.ts";
import { type Lane, type Registry, sessionFields } from "./registry.ts";
import type { ChosenRuntimes } from "./run.ts";

export type OpenedLane =
  | { readonly kind: "opened"; readonly lane: Lane; readonly ref: SessionRef }
  | { readonly kind: "taken" }
  | { readonly kind: "failed"; readonly what: string; readonly error: unknown };

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Bind the private route only to this launch, not its shell or a later OMP session in the same pane. */
export const laneStartCommand = (lane: Pick<Lane, "key" | "thread">, argv: readonly string[]): string => {
  const prefix =
    lane.thread.startsWith("discord:") && isDiscordSnowflake(lane.thread.slice("discord:".length))
      ? `CATALY_ASK_LAUNCHED_LANE=${quoteForPane(lane.key)} `
      : "";
  return `${prefix}${argv.map(quoteForPane).join(" ")}`;
};

// Each cleanup step is tried on its own: one that fails is reported and never stops the others.
const removeStaged = (staged: string): void => {
  try {
    rmSync(staged, { force: true });
  } catch (error) {
    process.stderr.write(`dori: could not remove the staged brief ${staged} (${why(error)})\n`);
  }
};

// A nonzero exit alone is not proof: the transport may have failed after terminal creation.
const creationWasRejected = (rts: ChosenRuntimes, error: unknown): boolean => {
  if (rts.failure !== undefined && error === rts.failure) return true;
  if (!(error instanceof ToolError)) return false;
  if (error.result.spawnFailed) return true;
  if (error instanceof HcError) {
    // A failed list was preflight; after `run`, only an explicit rejection reply proves non-creation.
    return error.argv[1] === "ls" || isReportedKind(error, "usage", "invalid_params", "name_taken");
  }
  try {
    const response: unknown = JSON.parse(error.result.stderr || error.result.stdout);
    if (!response || typeof response !== "object" || !("error" in response)) return false;
    const rejection = response.error;
    return (
      rejection !== null &&
      typeof rejection === "object" &&
      "code" in rejection &&
      rejection.code === "server_not_running"
    );
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

// A brief that is a link (a shared template) is written through it, as a plain write would.
const briefTarget = (brief: string): string => {
  try {
    return realpathSync(brief);
  } catch {
    return brief;
  }
};

/**
 * Opens a lane's session and registers it before its agent starts (dori report refuses an unknown key, so a fast
 * lane's first report would be lost). Stage generated briefs privately before terminal creation and publish
 * them only when it returns a terminal identity. A confirmed rejection can discard just that private attempt.
 * An explicit brief is staged beside its path, then rewritten in place only once this launch owns the key. A failed
 * rewrite puts its original bytes back. A key that another launch or adopt registered meanwhile is `taken`; its
 * record and explicit brief stay. On failure, close the created session and remove temporary files and our record.
 */
export const openLaneSession = async (
  registry: Registry,
  rts: ChosenRuntimes,
  spec: CreateSpec,
  draft: Lane,
  { preamble, generated }: { readonly preamble: string; readonly generated: boolean },
): Promise<OpenedLane> => {
  let generatedAttempt: GeneratedBrief | undefined;
  let staged:
    | { readonly target: string; readonly pending: string; readonly backup: string; readonly original: Buffer }
    | undefined;
  const cleanup = (keepBackup = false): void => {
    if (!staged) return;
    removeStaged(staged.pending);
    if (!keepBackup) removeStaged(staged.backup);
  };
  try {
    if (generated) {
      generatedAttempt = stageGeneratedBrief(draft.brief, preamble);
    } else {
      const target = briefTarget(draft.brief);
      accessSync(target, constants.W_OK);
      staged = {
        target,
        pending: `${target}.${process.pid}.${randomUUID()}.launch`,
        // If a failed rewrite cannot be restored, the original stays where the error names it.
        backup: `${target}.${process.pid}.${randomUUID()}.original`,
        original: readFileSync(target),
      };
      writeFileSync(staged.pending, preamble, { flag: "wx", mode: 0o600 });
      writeFileSync(staged.backup, staged.original, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    cleanup();
    return { kind: "failed", what: generated ? "generated brief not writable" : "brief not writable", error };
  }
  let ref: SessionRef;
  try {
    ref = await rts.default.create(spec);
  } catch (error) {
    cleanup();
    if (generatedAttempt && creationWasRejected(rts, error)) {
      discardGeneratedBrief(generatedAttempt);
      generatedAttempt = undefined;
    }
    const what = generatedAttempt
      ? `session create failed; generated brief retained at ${generatedAttempt.brief}`
      : "session create failed";
    return { kind: "failed", what, error };
  }
  const lane: Lane = { ...draft, ...sessionFields(ref), ...placementFields(spec.container, ref) };
  let registered = false;
  let keepBackup = false;
  let failure: OpenedLane = { kind: "taken" };
  try {
    if (generatedAttempt) {
      publishGeneratedBrief(generatedAttempt, draft.brief);
      generatedAttempt = undefined;
    }
    registered = await registry.create(lane);
    if (registered) {
      // Written in place, as the brief file itself: its inode, hard links, owner, group, mode and ACL stay.
      if (staged) writeFileSync(staged.target, preamble);
      cleanup();
      return { kind: "opened", lane, ref };
    }
  } catch (error) {
    const what = generatedAttempt
      ? `generated brief not published; retained at ${generatedAttempt.brief}`
      : "lane not registered";
    failure = { kind: "failed", what, error };
    if (registered && staged) {
      let reason = error;
      try {
        writeFileSync(staged.target, staged.original);
      } catch (restoreError) {
        keepBackup = true;
        reason = new Error(
          `${why(error)}; the original brief is kept at ${staged.backup} (it could not be put back: ${why(restoreError)})`,
        );
      }
      failure = { kind: "failed", what: "brief not written", error: reason };
    }
  }
  cleanup(keepBackup);
  if (registered)
    await registry.discard(lane).catch((error: unknown) => {
      process.stderr.write(`dori: could not remove lane ${lane.key} after its launch failed (${why(error)})\n`);
    });
  await rts
    .for(ref)
    .close(ref, ref.container ? "container" : "session")
    .catch((error: unknown) => {
      process.stderr.write(
        `dori: could not close ${formatRef(ref)} after lane ${lane.key} did not open (${why(error)})\n`,
      );
    });
  return failure;
};

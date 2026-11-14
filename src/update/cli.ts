import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { UpdateDetectionUnavailable, UpdateError } from "./config.ts";
import { DoriUpdater } from "./controller.ts";
import { restartDeployment } from "./deployment.ts";
import { loadUpdateConfig } from "./load.ts";
import { acknowledgeStopped, restoreUpdate, snapshotUpdate } from "./recovery.ts";
import { persistReport } from "./report.ts";
import { saveJson } from "./state.ts";

const COMMANDS = ["check", "stage", "watch", "status", "snapshot", "restore", "recover", "restart"];
const USAGE = `dori upstream <check|stage|watch|status|snapshot|restore|recover|restart> --config FILE
  check       detect a changed Dori ref once; resume ready promotion before detection
  stage       explicitly stage the current pinned ref, including the effective baseline (deduplicated)
  watch       keep checking; resume pending exact-head CI, stop on held/interrupted work
  status      print private local JSON candidate, publication and deployment state
  snapshot    --job ID --output NEW_DIR [--app-state DIR]: freeze code, control evidence and explicit candidate app data
  restore     --input SNAPSHOT_DIR --output NEW_DIR: restore an isolated recovery copy, never readiness
  recover     --ack-stopped ID|none: acknowledge every old child stopped; clear ambiguous model ownership
  restart     restart only the configured managed deployment through its identity-bound lock and health readback
Default is staging only. Explicit promotion config enables verified publication and optional running Dori replacement.`;

/** Exit codes: 0 ok/unchanged/ready, 3 held/failed candidate, 4 detector unavailable (retryable), 2 operator error, 130 interrupted. */
export async function runUpdate(argv: readonly string[]): Promise<number> {
  let updater: DoriUpdater | undefined;
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  try {
    const args = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        job: { type: "string" },
        output: { type: "string" },
        input: { type: "string" },
        "ack-stopped": { type: "string" },
        "app-state": { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (args.values.help || args.positionals.length === 0) {
      console.log(USAGE);
      return 0;
    }
    const command = args.positionals[0] ?? "";
    if (args.positionals.length !== 1 || !COMMANDS.includes(command)) throw new UpdateError(USAGE);
    const need = (value: string | undefined, name: string): string => {
      if (!value) throw new UpdateError(`update ${command} requires --${name}`);
      return value;
    };
    updater = new DoriUpdater(loadUpdateConfig(resolve(need(args.values.config, "config"))), undefined, stop.signal);
    const ctx = updater.context;
    process.on("SIGTERM", interrupt);
    process.on("SIGINT", interrupt);
    if (command === "status") {
      console.log(JSON.stringify(updater.status(), null, 2));
      return 0;
    }
    if (command === "snapshot") {
      const snapshot = snapshotUpdate(
        ctx,
        need(args.values.job, "job"),
        need(args.values.output, "output"),
        args.values["app-state"],
      );
      console.log(JSON.stringify({ type: "DORI_UPDATE_RECOVERY", snapshot }));
      return 0;
    }
    if (command === "restore") {
      const restored = restoreUpdate(ctx, need(args.values.input, "input"), need(args.values.output, "output"));
      console.log(JSON.stringify({ type: "DORI_UPDATE_RECOVERY", restored, phase: "interrupted" }));
      return 0;
    }
    if (command === "recover") {
      const job = acknowledgeStopped(ctx, need(args.values["ack-stopped"], "ack-stopped"));
      if (job) persistReport(ctx, job);
      return 0;
    }
    if (command === "restart") {
      const deployment = ctx.config.promotion?.deployment;
      if (!deployment) throw new UpdateError("update restart requires configured promotion.deployment");
      const record = await restartDeployment(deployment, stop.signal);
      console.log(
        JSON.stringify({ type: "DORI_UPDATE", target: "dori", event: "managed-restart", status: record.status }),
      );
      return stop.signal.aborted ? 130 : record.status === "healthy" ? 0 : 3;
    }
    if (command === "watch") {
      const outcome = await updater.watch();
      return stop.signal.aborted ? 130 : outcome === "held" ? 3 : 0;
    }
    const result = await updater.once(command === "stage" ? "stage" : "check");
    const sent = result.job?.notification?.state;
    const unfinished =
      result.job !== undefined &&
      (result.job.phase !== "ready" ||
        result.job.problem !== undefined ||
        (ctx.config.promotion !== undefined && result.job.promotion?.status !== "complete"));
    return result.outcome === "held" || unfinished || sent === "failed" || sent === "ambiguous" || sent === "sending"
      ? 3
      : 0;
  } catch (error) {
    if (updater && existsSync(updater.context.config.root)) {
      // Diagnostics are private and must never hide the original failure.
      saveJson(resolve(updater.context.config.root, "cli-error.json"), {
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const visible =
      error instanceof UpdateError || String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS");
    console.error(
      JSON.stringify({
        type: "DORI_UPDATE",
        target: "dori",
        event: "error",
        reason:
          visible && error instanceof Error ? error.message : "operation failed; inspect dedicated updater artifacts",
      }),
    );
    return stop.signal.aborted ? 130 : error instanceof UpdateDetectionUnavailable ? 4 : 2;
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
}

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { BoardError, type BoardTarget, updateBoard } from "./board.ts";
import { type Command, die } from "./cli-context.ts";
import { LANE_KEY } from "./registry.ts";
import { laneEta, laneStatus, StatusError } from "./status.ts";
import { renderBoard, renderStatus } from "./status-render.ts";
import { readStatusRegistry } from "./status-registry.ts";

const status: Command = async ({ key, values, deps }) => {
  const snapshot = await laneStatus(deps, key);
  console.log(
    values["json"]
      ? JSON.stringify(snapshot, null, 2)
      : `${renderStatus(snapshot)}\nOBSERVED ${snapshot.observedAt} (read-only)`,
  );
};

const eta: Command = async ({ key, values, deps }) => {
  const prefix = key?.trim() || die("eta needs a nonempty lane-key prefix");
  const registry = await readStatusRegistry(deps.registry);
  const estimate = laneEta(registry.lanes, prefix);
  if (registry.errors.length) {
    console.log(
      values["json"]
        ? JSON.stringify({
            ...estimate,
            medianMinutes: null,
            minMinutes: null,
            maxMinutes: null,
            registryIncomplete: true,
            errors: registry.errors,
          })
        : `ETA ${prefix}: incomplete registry (readable n=${estimate.samples}); estimate unknown`,
    );
    return;
  }
  console.log(
    values["json"]
      ? JSON.stringify(estimate)
      : estimate.medianMinutes === null
        ? `ETA ${prefix}: insufficient history (n=${estimate.samples}; need 3)`
        : `ETA ${prefix}: p50 ${estimate.medianMinutes}m, range ${estimate.minMinutes}-${estimate.maxMinutes}m, n=${estimate.samples} (historical elapsed time, not a promise)`,
  );
};

const BOARD_OPTIONS = {
  to: { type: "string" },
  thread: { type: "string" },
  lane: { type: "string" },
  loop: { type: "string" },
  message: { type: "string" },
} as const;

const board: Command = async ({ rest, key, positionals, values, need, opt, loopMinutes, deps, config }) => {
  // Keep permissive tokenization for signed Telegram chat IDs, but admit only board's own options.
  const { tokens } = parseArgs({ args: rest, options: BOARD_OPTIONS, strict: false, tokens: true });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (!Object.hasOwn(BOARD_OPTIONS, token.name)) die(`unsupported board option ${token.rawName}`);
    if (seen.has(token.name)) die(`board option ${token.rawName} may only be specified once`);
    seen.add(token.name);
    if (typeof token.value !== "string") die(`${token.rawName} needs a value`);
  }
  if (positionals.length > 1) die("board accepts only one platform argument");
  if (key !== "discord" && key !== "telegram") return die("board needs discord or telegram");
  const lane = opt("lane");
  if (seen.has("lane") && (lane === undefined || !LANE_KEY.test(lane))) die("invalid --lane key");
  const minutes = loopMinutes();
  const messageId = opt("message");
  if (values["message"] !== undefined && !/^[1-9]\d*$/.test(messageId ?? ""))
    die("--message must be a positive decimal message ID");
  const thread = opt("thread");
  let target: BoardTarget;
  if (key === "discord") {
    if (values["to"] !== undefined && values["thread"] !== undefined) return die("choose --to or --thread, not both");
    const to = values["thread"] !== undefined ? (thread ?? "") : need("to");
    if (!/^[1-9]\d*$/.test(to)) die("board destination must be a positive decimal Discord ID");
    target = { platform: key, to };
  } else {
    const to = need("to");
    if (!/^-?[1-9]\d*$/.test(to)) die("board --to must be a numeric Telegram chat ID");
    if (values["thread"] !== undefined && (!/^[1-9]\d*$/.test(thread ?? "") || !Number.isSafeInteger(Number(thread))))
      die("board --thread must be a positive Telegram topic ID");
    if (messageId && !Number.isSafeInteger(Number(messageId))) die("--message must be a safe Telegram message ID");
    target = { platform: key, to, ...(thread ? { thread: Number(thread) } : {}) };
  }
  const name = key === "discord" ? "DORI_DISCORD_TOKEN" : "DORI_TELEGRAM_TOKEN";
  const token = process.env[name] ?? die(`${name} is not set`);
  let recovery = messageId;
  for (;;) {
    const snapshot = await laneStatus(deps, lane);
    if (lane !== undefined && snapshot.lanes.length === 0) die(`no readable registered lane ${lane}`);
    const result = await updateBoard({
      stateDir: config.stateDir,
      target,
      token,
      clock: deps.clock,
      body: renderBoard(snapshot, homedir(), key === "discord" ? 1960 : 4056),
      ...(recovery ? { messageId: recovery } : {}),
    });
    console.log(`BOARD ${key} ${result.action} ${result.messageId}`);
    recovery = undefined;
    if (minutes === 0) return;
    await deps.clock.sleep(minutes * 60_000);
  }
};

export const statusErrors = [StatusError, BoardError] as const;
export const statusCommands: Readonly<Record<string, Command>> = { status, board, eta };

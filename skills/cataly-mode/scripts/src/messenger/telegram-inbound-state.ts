import { join } from "node:path";
import { MessengerError } from "./http.ts";
import { privateStateFile } from "./private-state-file.ts";

export type TgInboundState = {
  readonly offset: number;
  readonly observedAt?: number;
  readonly seen: readonly string[];
};
export type TgInboundStore = { load(): TgInboundState | undefined; save(state: TgInboundState): void };

export const fileTgInboundStore = (stateDir: string, botId: number): TgInboundStore & { checkWritable(): void } => {
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new MessengerError("Telegram inbound bot ID is invalid", 0);
  const file = privateStateFile(join(stateDir, "telegram-inbound"), String(botId), "Telegram inbound cursor");
  let warned = false;
  return {
    checkWritable: file.checkWritable,
    load() {
      const raw = file.read();
      if (raw === undefined) return undefined;
      try {
        const state = JSON.parse(raw) as {
          version?: unknown;
          botId?: unknown;
          offset?: unknown;
          observedAt?: unknown;
          seen?: unknown;
        };
        if (!state || state.version !== 1) throw new Error();
        if (state.botId !== botId)
          throw new MessengerError(
            "Telegram inbound cursor belongs to a different bot; repair it before restarting intake",
            0,
          );
        if (
          typeof state.offset !== "number" ||
          !Number.isSafeInteger(state.offset) ||
          state.offset < 0 ||
          !Array.isArray(state.seen) ||
          state.seen.length > 100 ||
          !state.seen.every((key): key is string => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
        )
          throw new Error();
        const observedAt =
          typeof state.observedAt === "number" && Number.isSafeInteger(state.observedAt) && state.observedAt >= 0
            ? state.observedAt
            : undefined;
        return { offset: state.offset, ...(observedAt === undefined ? {} : { observedAt }), seen: state.seen };
      } catch (error) {
        if (error instanceof MessengerError) throw error;
        if (!warned) {
          warned = true;
          console.log(
            `WARN Telegram inbound cursor at ${file.path} is unparseable; polling without an offset (warned once)`,
          );
        }
        return undefined;
      }
    },
    save(state) {
      file.write(`${JSON.stringify({ version: 1, botId, ...state })}\n`);
    },
  };
};

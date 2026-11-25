import { HEADLESS_ADDRESS, type SessionRef } from "../../../../src/runtime/types.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";

export type NativeReference = {
  readonly sessionId: string;
  readonly ref: Pick<SessionRef, "runtime" | "id">;
};

/** A recorded launch attribution, not a native input-admission or completion receipt. */
export type ReportProvenance = {
  readonly requestId: string;
  readonly runId: string;
  readonly nativeRef?: NativeReference;
};

export type ReportDelivery =
  | { readonly state: "unverified"; readonly reason: string }
  | {
      readonly state: "linked";
      readonly deliveryId: string;
      readonly requestId: string;
      readonly channel: string;
      readonly remoteIds: readonly string[];
      readonly at: number;
    };

/** Physical input IDs only; unread summaries and invented dispatch UUIDs are not requests. */
export const isRequestId = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 3) return false;
  const [platform, channel, message] = parts;
  if (platform === "discord") return isDiscordSnowflake(channel) && isDiscordSnowflake(message);
  if (platform === "telegram")
    return (
      /^-?[1-9]\d*$/.test(channel ?? "") &&
      /^[1-9]\d*$/.test(message ?? "") &&
      Number.isSafeInteger(Number(channel)) &&
      Number.isSafeInteger(Number(message))
    );
  return platform === "slack" && /^[A-Z][A-Z0-9]+$/.test(channel ?? "") && /^\d+\.\d+$/.test(message ?? "");
};

/** This UUID identifies a Cataly launch invocation; it never substitutes for the original input ID. */
export const isRunId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export const isNativeReference = (value: unknown): value is NativeReference => {
  if (typeof value !== "object" || value === null || !("sessionId" in value) || !("ref" in value)) return false;
  const ref = value.ref;
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof ref === "object" &&
    ref !== null &&
    "runtime" in ref &&
    "id" in ref &&
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    (ref.runtime === "tern" || (ref.runtime === "headless" && HEADLESS_ADDRESS.test(ref.id)))
  );
};

export const isProvenance = (value: unknown): value is ReportProvenance =>
  typeof value === "object" &&
  value !== null &&
  "requestId" in value &&
  isRequestId(value.requestId) &&
  "runId" in value &&
  isRunId(value.runId) &&
  (!("nativeRef" in value) || isNativeReference(value.nativeRef));

export const provenanceIdentity = ({ requestId, runId, nativeRef }: ReportProvenance) =>
  [requestId, runId, nativeRef ? [nativeRef.sessionId, nativeRef.ref.runtime, nativeRef.ref.id] : null] as const;

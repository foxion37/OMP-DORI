// The voice backend's function tools. Arguments come from a model, so each is validated here before anything runs.
import type { FlowDeps } from "../done-flow.ts";
import type { Discord } from "../messenger/discord.ts";
import { forwardToLead, notSent } from "./relay.ts";
import type { VoiceSettings } from "./settings.ts";
import { clip, getStatus, type StatusSource } from "./status.ts";
import type { ToolResult, VoiceTool } from "./types.ts";

/** Below Discord's 2000-character message limit with room for the note marker. */
const NOTE_CHARS = 1800;
const SOURCES: Readonly<Record<StatusSource, true>> = { lanes: true, reports: true };

/** A tool call's arguments as an object: the parsed value, or its JSON text as the backend streams it. */
const argsOf = (args: unknown): Record<string, unknown> | undefined => {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const statusSources = (a: Record<string, unknown>): StatusSource[] | undefined => {
  const what = a["what"];
  if (!Array.isArray(what) || what.length === 0 || typeof a["speak_now"] !== "boolean") return undefined;
  if (!what.every((source): source is StatusSource => typeof source === "string" && Object.hasOwn(SOURCES, source)))
    return undefined;
  return [...new Set(what)];
};

const postNote = async (discord: Discord, channelId: string, text: string): Promise<ToolResult> => {
  const note = [...text.replace(/\p{Cc}/gu, (char) => (char === "\n" ? char : " ")).trim()]
    .slice(0, NOTE_CHARS)
    .join("");
  if (!note.trim()) return { ok: false, result: "not-posted: the note is empty" };
  try {
    await discord.send(channelId, `Voice note: ${note.trim()}`);
    return { ok: true, result: "posted: the note is in the owner's Discord text channel" };
  } catch (e) {
    return { ok: false, result: `not-posted: ${clip(e instanceof Error ? e.message : String(e), 200)}` };
  }
};

/**
 * get_status {what, speak_now}, post_note {text} and forward_to_lead {message, risky}. No tool runs a shell or
 * logs its arguments; invalid arguments run nothing.
 */
export const voiceTools =
  (deps: FlowDeps, discord: Discord, settings: VoiceSettings): VoiceTool =>
  async (name, raw) => {
    const a = argsOf(raw);
    if (name === "get_status") {
      const what = a && statusSources(a);
      if (!what) return { ok: false, result: "invalid get_status arguments: what=[lanes|reports...], speak_now" };
      return getStatus(deps, what);
    }
    if (name === "post_note") {
      const text = a?.["text"];
      if (typeof text !== "string") return { ok: false, result: "not-posted: invalid post_note arguments" };
      return postNote(discord, settings.textChannelId, text);
    }
    if (name === "forward_to_lead") {
      const message = a?.["message"];
      const risky = a?.["risky"];
      if (typeof message !== "string" || typeof risky !== "boolean")
        return notSent("invalid forward_to_lead arguments (message, risky)");
      return forwardToLead(deps, { message, risky });
    }
    return { ok: false, result: `unknown tool: ${clip(name, 60)}` };
  };

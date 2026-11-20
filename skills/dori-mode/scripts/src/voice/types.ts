import type { Playback } from "./audio.ts";
import type { Replies } from "./replies.ts";
import type { VoiceSession } from "./session.ts";
import type { VoiceUsage } from "./usage.ts";

export type VoiceSessionPorts = {
  now(): number;
  key: string;
  open: OpenVoiceSocket;
  tool: VoiceTool;
  playback: Playback;
  replies: Replies;
  usage: VoiceUsage;
  log(line: string): void;
  started(): void;
  finished(session: VoiceSession): Promise<void>;
};

export type ToolResult = {
  ok: boolean;
  result: string;
  parts?: Record<string, { ok: boolean; result: string }>;
};
export type VoiceTool = (name: string, args: unknown) => Promise<ToolResult>;
export type Wire = Record<string, unknown>;
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};
export type BackendItem = {
  id: string;
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  status?: string;
  content?: { type: string; text?: string }[];
};
export type BackendEvent = {
  type: string;
  response?: { id: string; usage?: Usage; error?: { code?: string } };
  item?: BackendItem;
  item_id?: string;
  delta?: string;
};
export type LiveEvent = {
  type: string;
  session?: { id: string };
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  event?: BackendEvent;
  delegation_id?: string | null;
  delegation?: { id: string; response_id?: string };
  usage?: { seconds?: number };
  client_event_id?: string;
  error?: { code?: string; client_event_id?: string };
};
export type VoiceSocket = {
  send(event: Wire): void;
  close(): void;
  terminate(): void;
};
export type OpenVoiceSocket = (
  key: string,
  handlers: { open(): void; event(event: LiveEvent): void; closed(): void; error(): void },
) => VoiceSocket;
export type Action = { tool: string; ok: boolean; result: string };
export type PartialFact = {
  id: string;
  content: string;
  readyAt: number;
  offeredAt?: number;
  ackedAt?: number;
  rejected?: boolean;
};
export type BackendCall = {
  name: string;
  started: boolean;
  executing: boolean;
  cancelled: boolean;
};
export type BackendResponse = {
  id: string;
  calls: Map<string, BackendCall>;
  items: Set<string>;
  text: string;
  terminal?: string;
  terminalAt?: number;
  firstTextAt?: number;
  continued?: boolean;
};
export type Delegation = {
  id: string;
  createdAt: number;
  lastEventAt: number;
  activeResponseId?: string;
  status: string;
  responses: Map<string, BackendResponse>;
  partials: PartialFact[];
  doneAt?: number;
  finalText?: string;
};

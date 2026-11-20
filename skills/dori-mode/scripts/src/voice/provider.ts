import type { BackendEvent, BackendItem, LiveEvent, OpenVoiceSocket, Usage } from "./types.ts";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid voice provider object");
  return Object.fromEntries(Object.entries(value));
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid voice provider text");
  return value;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid voice provider number");
  return value;
};
export const parseUsage = (value: unknown): Usage => {
  const raw = object(value);
  const usage: Usage = {};
  if (raw["input_tokens"] !== undefined) usage.input_tokens = number(raw["input_tokens"]);
  if (raw["output_tokens"] !== undefined) usage.output_tokens = number(raw["output_tokens"]);
  if (raw["input_tokens_details"] !== undefined && raw["input_tokens_details"] !== null) {
    const details = object(raw["input_tokens_details"]);
    usage.input_tokens_details = {};
    if (details["cached_tokens"] !== undefined)
      usage.input_tokens_details.cached_tokens = number(details["cached_tokens"]);
    if (details["cache_write_tokens"] !== undefined)
      usage.input_tokens_details.cache_write_tokens = number(details["cache_write_tokens"]);
  }
  return usage;
};
const parseItem = (value: unknown): BackendItem => {
  const raw = object(value);
  const item: BackendItem = { id: text(raw["id"]), type: text(raw["type"]) };
  for (const key of ["call_id", "name", "arguments", "status"] as const)
    if (raw[key] !== undefined) item[key] = text(raw[key]);
  if (raw["content"] !== undefined) {
    if (!Array.isArray(raw["content"])) throw new Error("Invalid voice provider content");
    item.content = raw["content"].map((value: unknown) => {
      const part = object(value);
      return { type: text(part["type"]), ...(part["text"] === undefined ? {} : { text: text(part["text"]) }) };
    });
  }
  return item;
};
const parseBackend = (value: unknown): BackendEvent => {
  const raw = object(value);
  const event: BackendEvent = { type: text(raw["type"]) };
  if (raw["response"] !== undefined) {
    const response = object(raw["response"]);
    event.response = { id: text(response["id"]) };
    if (response["error"] !== undefined && response["error"] !== null) {
      const error = object(response["error"]);
      event.response.error = error["code"] === undefined ? {} : { code: text(error["code"]) };
    }
    if (response["usage"] !== undefined && response["usage"] !== null)
      event.response.usage = parseUsage(response["usage"]);
  }
  if (raw["item"] !== undefined) event.item = parseItem(raw["item"]);
  if (raw["item_id"] !== undefined) event.item_id = text(raw["item_id"]);
  if (raw["delta"] !== undefined) event.delta = text(raw["delta"]);
  return event;
};

export const parseLiveEvent = (value: unknown): LiveEvent => {
  const raw = object(value);
  const event: LiveEvent = { type: text(raw["type"]) };
  for (const key of ["delta", "client_event_id"] as const) if (raw[key] !== undefined) event[key] = text(raw[key]);
  for (const key of ["start_ms", "end_ms"] as const) if (raw[key] !== undefined) event[key] = number(raw[key]);
  if (raw["session"] !== undefined) event.session = { id: text(object(raw["session"])["id"]) };
  if (raw["event"] !== undefined) event.event = parseBackend(raw["event"]);
  if (raw["delegation_id"] !== undefined)
    event.delegation_id = raw["delegation_id"] === null ? null : text(raw["delegation_id"]);
  if (raw["delegation"] !== undefined) {
    const d = object(raw["delegation"]);
    event.delegation = {
      id: text(d["id"]),
      ...(d["response_id"] === undefined ? {} : { response_id: text(d["response_id"]) }),
    };
  }
  if (raw["usage"] !== undefined) {
    const usage = object(raw["usage"]);
    event.usage = usage["seconds"] === undefined ? {} : { seconds: number(usage["seconds"]) };
  }
  if (raw["error"] !== undefined) {
    const error = object(raw["error"]);
    event.error = {};
    for (const key of ["code", "client_event_id"] as const)
      if (error[key] !== undefined) event.error[key] = text(error[key]);
  }
  return event;
};

/** Bun's WebSocket supports request headers; no token is put in a URL, argv or log. */
export const openVoiceSocket: OpenVoiceSocket = (key, handlers) => {
  const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } });
  ws.addEventListener("open", handlers.open);
  ws.addEventListener("message", (message) => {
    try {
      handlers.event(parseLiveEvent(JSON.parse(String(message.data))));
    } catch {
      handlers.error();
    }
  });
  ws.addEventListener("error", handlers.error);
  ws.addEventListener("close", handlers.closed);
  return { send: (event) => ws.send(JSON.stringify(event)), close: () => ws.close(), terminate: () => ws.terminate() };
};

export const parseSummary = (value: unknown): { text: string; usage?: Usage } => {
  const raw = object(value);
  if (!Array.isArray(raw["output"])) throw new Error("Invalid summary output");
  const result = raw["output"]
    .flatMap((value: unknown) => {
      const item = object(value);
      if (item["type"] !== "message") return [];
      return (parseItem(item).content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "");
    })
    .join("")
    .trim();
  if (!result) throw new Error("Empty voice summary");
  return { text: result, ...(raw["usage"] === undefined ? {} : { usage: parseUsage(raw["usage"]) }) };
};

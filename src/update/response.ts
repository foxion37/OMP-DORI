import { object, UpdateInterrupted } from "./config.ts";

export type AgentResponse = { readonly text: string; readonly observedModel: string };

const MESSAGE_EVENTS = ["message_start", "message_update", "message_end"];

/**
 * OMP `--mode json`: a completed assistant `message_end` plus a matching terminal `agent_end` attest the final text
 * and the model that actually answered. Tool output, user messages, streaming deltas and nonterminal ends never do.
 */
export function readAgentResponse(stdout: string): AgentResponse {
  let final: Record<string, unknown> | undefined;
  let terminal: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!object(event)) continue;
    const message = object(event["message"]) ? event["message"] : undefined;
    const assistantActivity =
      MESSAGE_EVENTS.includes(String(event["type"])) &&
      (message === undefined ? event["type"] === "message_update" : message["role"] === "assistant");
    // Any later assistant activity means the earlier terminal answer is no longer the end of the run.
    if (assistantActivity || (event["type"] === "agent_end" && event["isTerminal"] !== true)) terminal = undefined;
    if (event["type"] === "message_end" && message?.["role"] === "assistant") final = message;
    if (event["type"] === "agent_end" && event["isTerminal"] === true && Array.isArray(event["messages"])) {
      terminal = event["messages"].findLast((entry) => object(entry) && entry["role"] === "assistant");
    }
  }
  if (
    final?.["stopReason"] !== "stop" ||
    typeof final["provider"] !== "string" ||
    !final["provider"] ||
    typeof final["model"] !== "string" ||
    !final["model"] ||
    !Array.isArray(final["content"])
  ) {
    throw new UpdateInterrupted("OMP returned no successfully completed final assistant message");
  }
  if (
    !terminal ||
    terminal["provider"] !== final["provider"] ||
    terminal["model"] !== final["model"] ||
    terminal["stopReason"] !== "stop" ||
    JSON.stringify(terminal["content"]) !== JSON.stringify(final["content"])
  ) {
    throw new UpdateInterrupted("OMP has no matching terminal agent_end; async or interrupted work remains unproven");
  }
  const text = final["content"]
    .flatMap((part) =>
      object(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : [],
    )
    .join("\n");
  return { text, observedModel: `${final["provider"]}/${final["model"]}` };
}

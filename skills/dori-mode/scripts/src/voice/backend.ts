import { randomUUID } from "node:crypto";
import { quickFacts } from "./facts.ts";
import type { Action, BackendEvent, BackendResponse, Delegation, Usage, VoiceTool, Wire } from "./types.ts";

type Ports = {
  now(): number;
  active(): boolean;
  send(event: Wire): void;
  tool: VoiceTool;
  usage(usage: Usage | undefined): void;
  search(): void;
  action(action: Action): void;
  log(line: string): void;
};

/** One instance per Live session. Lifecycle snapshots do not contain output items. */
export class Backend {
  readonly delegations = new Map<string, Delegation>();
  readonly pending = new Map<string, { delegationId: string; name: string }>();
  private effects: Promise<unknown> = Promise.resolve();
  private readonly searches = new Set<string>();
  private readonly usageResponses = new Set<string>();
  constructor(private readonly ports: Ports) {}

  created(id: string, responseId?: string): Delegation {
    const existing = this.delegations.get(id);
    if (existing) return existing;
    const now = this.ports.now();
    const record: Delegation = {
      id,
      createdAt: now,
      lastEventAt: now,
      status: "running",
      responses: new Map(),
      partials: [],
      ...(responseId ? { activeResponseId: responseId } : {}),
    };
    this.delegations.set(id, record);
    return record;
  }

  private resolve(event: BackendEvent, id?: string | null): Delegation | undefined {
    if (id && this.delegations.has(id)) return this.delegations.get(id);
    const responseId = event.response?.id;
    const records = [...this.delegations.values()];
    const known = responseId && records.find((d) => d.activeResponseId === responseId || d.responses.has(responseId));
    if (known) return known;
    const candidates = records.filter((d) => {
      if (d.status !== "running" || !d.activeResponseId) return false;
      const r = d.responses.get(d.activeResponseId);
      return responseId ? event.type === "response.created" && r?.continued : !r?.terminal;
    });
    const itemId = event.item?.id ?? event.item_id;
    const matches = candidates.filter((d) => itemId && d.responses.get(d.activeResponseId!)?.items.has(itemId));
    if (matches.length === 1) return matches[0];
    if (candidates.length === 1) return candidates[0];
    if (responseId && event.type === "response.created") return this.created(`response:${responseId}`, responseId);
    this.ports.log(`VOICE_BACKEND_UNCORRELATED ${event.type}`);
    return undefined;
  }

  private recordUsage(id: string, usage: Usage | undefined): void {
    if (usage === undefined || this.usageResponses.has(id)) return;
    this.usageResponses.add(id);
    this.ports.usage(usage);
  }

  async event(event: BackendEvent, delegationId?: string | null): Promise<void> {
    const item = event.item;
    // Provider work is billable even after close/cap or when its delegation cannot be resolved.
    const terminal = ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(
      event.type,
    );
    if (terminal && event.response?.id) this.recordUsage(event.response.id, event.response.usage);
    if (event.type === "response.output_item.done" && item?.type === "web_search_call" && !this.searches.has(item.id)) {
      this.searches.add(item.id);
      this.ports.search();
      this.ports.action({ tool: "web_search", ok: item.status === "completed", result: "Search completed" });
    }
    const d = this.resolve(event, delegationId);
    if (!d) return;
    const id = event.response?.id ?? d.activeResponseId;
    if (!id) return;
    let r = d.responses.get(id);
    if (!r) {
      r = { id, calls: new Map(), items: new Set(), text: "" };
      d.responses.set(id, r);
    }
    if (terminal && !event.response?.id) this.recordUsage(id, event.response?.usage);
    if (!this.ports.active() || d.status === "stale" || r.terminal) return;
    const now = this.ports.now();
    d.lastEventAt = now;
    if (event.item?.id) r.items.add(event.item.id);
    if (event.type === "response.created") {
      d.activeResponseId = id;
      d.status = "running";
      delete d.doneAt;
    }
    if (event.type === "response.output_text.delta") {
      r.firstTextAt ??= now;
      r.text += event.delta ?? "";
    }
    if (
      (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
      item?.type === "function_call"
    ) {
      if (!item.call_id || !item.name) return;
      if (!r.calls.has(item.call_id)) {
        r.calls.set(item.call_id, { name: item.name, started: false, executing: false, cancelled: false });
        this.pending.set(item.call_id, { delegationId: d.id, name: item.name });
      }
      if (event.type === "response.output_item.done") await this.execute(d, r, item.call_id, item.arguments ?? "{}");
      return;
    }
    if (event.type === "response.output_item.done" && item?.type === "message")
      r.text = (item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("");
    if (!terminal) return;
    r.terminal = event.type.slice("response.".length);
    r.terminalAt = now;
    if (r.terminal !== "completed") {
      d.status = r.terminal;
      for (const [callId, call] of r.calls) {
        if (!call.executing) {
          call.cancelled = true;
          this.pending.delete(callId);
        }
      }
    }
    this.settle();
  }

  private async execute(d: Delegation, r: BackendResponse, callId: string, raw: string): Promise<void> {
    const call = r.calls.get(callId)!;
    if (call.started || call.cancelled) return;
    call.started = true;
    let args: unknown;
    try {
      args = JSON.parse(raw);
    } catch {
      args = null;
    }
    const execute = async () => {
      if (!this.ports.active() || call.cancelled || (r.terminal && r.terminal !== "completed"))
        return { ok: false, result: "Session or request ended; not executed" };
      if (!args || typeof args !== "object") return { ok: false, result: "Invalid tool arguments" };
      call.executing = true;
      try {
        return await this.ports.tool(call.name, args);
      } catch {
        return { ok: false, result: "Tool failed; do not claim completion or retry an uncertain write" };
      }
    };
    const task = call.name === "get_status" ? execute() : this.effects.then(execute);
    if (call.name !== "get_status") this.effects = task;
    const result = await task;
    this.ports.action({ tool: call.name, ok: result.ok, result: result.result.slice(0, 500) });
    if (
      call.name === "get_status" &&
      args &&
      typeof args === "object" &&
      "speak_now" in args &&
      args.speak_now === true &&
      result.ok &&
      result.parts
    ) {
      d.partials.push({ id: `quick_${randomUUID()}`, content: quickFacts(result.parts), readyAt: this.ports.now() });
    }
    if (this.ports.active() && (!r.terminal || r.terminal === "completed")) {
      this.ports.send({
        type: "response.item.create",
        event_id: randomUUID(),
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ ok: result.ok, result: result.result }),
        },
      });
    }
    this.pending.delete(callId);
    this.settle();
  }

  private settle(): void {
    if (!this.ports.active()) return;
    for (const d of this.delegations.values()) {
      const records = [...d.responses.values()];
      const last = records.at(-1);
      const pending = [...this.pending.values()].some((call) => call.delegationId === d.id);
      if (
        d.doneAt === undefined &&
        last?.terminal === "completed" &&
        !last.calls.size &&
        !pending &&
        records.every((r) => r.terminal)
      ) {
        d.status = "completed";
        d.doneAt = last.terminalAt!;
        d.finalText = last.text;
      }
    }
    const responses = [...this.delegations.values()].flatMap((d) => [...d.responses.values()]);
    if (this.pending.size || responses.some((r) => !r.terminal)) return;
    const ready = responses.filter((r) => r.terminal === "completed" && r.calls.size && !r.continued);
    if (!ready.length) return;
    for (const r of ready) r.continued = true;
    this.ports.send({ type: "response.create", event_id: randomUUID() });
  }

  /** A stalled server still awaits its outputs: close the session, never fabricate them or continue. */
  expired(): boolean {
    for (const d of this.delegations.values()) {
      if (d.status !== "running" || this.ports.now() - d.lastEventAt < 120_000) continue;
      d.status = "stale";
      for (const r of d.responses.values())
        for (const call of r.calls.values()) if (!call.executing) call.cancelled = true;
      return true;
    }
    return false;
  }

  blocksReply(): boolean {
    if (this.pending.size) return true;
    return [...this.delegations.values()].some(
      (d) => d.status === "running" || (d.doneAt !== undefined && this.ports.now() - d.doneAt < 10_000),
    );
  }
}

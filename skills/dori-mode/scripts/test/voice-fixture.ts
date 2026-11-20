import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend } from "../src/voice/backend.ts";
import { voiceSettings, type VoiceSettings } from "../src/voice/settings.ts";
import type { Action, BackendEvent, VoiceTool, Wire } from "../src/voice/types.ts";

export const settings = (patch: Partial<VoiceSettings> = {}): VoiceSettings =>
  voiceSettings({
    enabled: true,
    channelId: "100000000000000001",
    textChannelId: "100000000000000002",
    liveModel: "fixture-live",
    backendModel: "fixture-backend",
    summaryModel: "fixture-summary",
    voice: "fixture-voice",
    webSearchUsdPerCall: 0.01,
    prices: {
      "fixture-backend": { input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
      "fixture-summary": { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
    },
    ...patch,
  });

export const temporaryVoice = () => {
  const directory = mkdtempSync(join(tmpdir(), "dori-voice-test-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
};

export const backendFixture = (tool: VoiceTool = async () => ({ ok: true, result: "fixture result" })) => {
  let now = 2000;
  let active = true;
  const wires: Wire[] = [];
  const actions: Action[] = [];
  const logs: string[] = [];
  let searches = 0;
  let usages = 0;
  const backend = new Backend({
    now: () => now,
    active: () => active,
    tool,
    send: (event) => wires.push(event),
    action: (action) => actions.push(action),
    log: (line) => logs.push(line),
    search: () => {
      searches++;
    },
    usage: () => {
      usages++;
    },
  });
  backend.created("d1", "r1");
  return {
    backend,
    wires,
    actions,
    logs,
    now: () => now,
    time: (value: number) => {
      now = value;
    },
    stop: () => {
      active = false;
    },
    counts: () => ({ searches, usages }),
  };
};
export const created = (id: string): BackendEvent => ({ type: "response.created", response: { id } });
export const completed = (id: string): BackendEvent => ({ type: "response.completed", response: { id } });
export const call = (
  id: string,
  name = "get_status",
  args: unknown = { what: ["lanes"], speak_now: false },
): BackendEvent => ({
  type: "response.output_item.done",
  item: { type: "function_call", id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args) },
});
export const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
export const count = (wires: Wire[], type: string): number => wires.filter((e) => e["type"] === type).length;

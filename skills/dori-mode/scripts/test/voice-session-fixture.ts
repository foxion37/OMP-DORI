import { VoiceAssistant } from "../src/voice/assistant.ts";
import { Playback } from "../src/voice/audio.ts";
import { Replies } from "../src/voice/replies.ts";
import type { VoiceSession } from "../src/voice/session.ts";
import type { VoiceSettings } from "../src/voice/settings.ts";
import type { LiveEvent, OpenVoiceSocket, Wire } from "../src/voice/types.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { flush, settings, temporaryVoice } from "./voice-fixture.ts";

type Handlers = { open(): void; event(event: LiveEvent): void; closed(): void; error(): void };
export const fixture = (patch: Partial<VoiceSettings> = {}, summarize?: (session: VoiceSession) => Promise<void>) => {
  const temp = temporaryVoice();
  const config = settings(patch);
  let now = 1000;
  const sessions: { handlers: Handlers; wires: Wire[] }[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  let tools = 0;
  let summaries = 0;
  const failedSummaries: boolean[] = [];
  const open: OpenVoiceSocket = (_key, handlers) => {
    const wires: Wire[] = [];
    sessions.push({ handlers, wires });
    return { send: (e) => wires.push(e), close: () => handlers.closed(), terminate: () => handlers.closed() };
  };
  const playback = new Playback();
  const usage = new VoiceUsage(temp.directory, config, () => now);
  const engine = new VoiceAssistant(config, {
    now: () => now,
    key: "synthetic-no-paid-key",
    open,
    playback,
    usage,
    replies: new Replies(temp.directory, (line) => logs.push(line)),
    log: (line) => logs.push(line),
    tool: async () => {
      tools++;
      return { ok: true, result: "fixture" };
    },
    notify: async (line) => {
      notices.push(line);
    },
    summarize: async (session) => {
      failedSummaries.push(session.failed);
      summaries++;
      await summarize?.(session);
    },
  });
  const start = async () => {
    engine.ownerPresence(true);
    const current = sessions.at(-1)!;
    current.handlers.open();
    current.handlers.event({ type: "session.started", session: { id: `session-${sessions.length}` } });
    await flush();
    return current;
  };
  return {
    ...temp,
    engine,
    sessions,
    notices,
    logs,
    failedSummaries,
    playback,
    usage,
    start,
    time: (n: number) => {
      now = n;
    },
    counts: () => ({ tools, summaries }),
  };
};
export const voiced = () => {
  const buffer = Buffer.alloc(3840);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(3000, i);
  return buffer;
};

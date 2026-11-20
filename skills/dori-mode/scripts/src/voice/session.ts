import { randomUUID } from "node:crypto";
import { InputAudio, rmsDbfs } from "./audio.ts";
import { Backend } from "./backend.ts";
import { Commentary } from "./commentary.ts";
import { startEvent } from "./prompts.ts";
import type { VoiceSettings } from "./settings.ts";
import type { Action, LiveEvent, VoiceSessionPorts, VoiceSocket, Wire } from "./types.ts";
export class VoiceSession {
  state: "connecting" | "live" | "capping" | "closing" | "closed" = "connecting";
  readonly openedAt: number;
  failed = false;
  private lastCommentaryAt = 0;
  readonly actions: Action[] = [];
  readonly inputTranscript: string[] = [];
  readonly outputTranscript: string[] = [];
  readonly backend: Backend;
  private readonly completion = Promise.withResolvers<void>();
  readonly done = this.completion.promise;
  private readonly commentary: Commentary;
  private socket: VoiceSocket | undefined;
  private startedAt: number | undefined;
  private closingAt: number | undefined;
  private capAt: number | undefined;
  private lastOwnerAt = 0;
  private lastOutputAt = 0;
  private recordedSeconds = 0;
  private lastRecordedAt = 0;
  private input: InputAudio | undefined;
  private tasks = new Set<Promise<void>>();
  private finalized = false;
  constructor(
    private readonly settings: VoiceSettings,
    private readonly ports: VoiceSessionPorts,
    private readonly greet: boolean,
  ) {
    this.openedAt = ports.now();
    this.backend = new Backend({
      now: ports.now,
      active: () => this.state === "live" && !ports.usage.capReason(),
      send: (event) => this.send(event),
      tool: ports.tool,
      usage: (usage) => {
        ports.usage.backend(usage, settings.backendModel);
      },
      search: () => ports.usage.search(),
      action: (action) => this.actions.push(action),
      log: ports.log,
    });
    this.commentary = new Commentary(ports.replies, this.backend, (event) => this.send(event), ports.log);
  }
  open(): void {
    this.socket = this.ports.open(this.ports.key, {
      open: () => {
        if (this.state !== "connecting") return;
        this.socket?.send(startEvent(this.settings));
      },
      event: (event) => {
        const task = this.event(event).catch(() => {
          this.ports.log("VOICE_EVENT_FAILED");
          this.close("provider event failure");
        });
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
      },
      error: () => {
        this.ports.log("VOICE_PROVIDER_ERROR");
        this.close("provider connection failure");
      },
      closed: () => {
        if (this.state !== "closing") this.failed = true;
        void this.finish();
      },
    });
  }
  private send(event: Wire): void {
    if (this.state === "live" || (this.state === "capping" && event["type"] === "session.input_audio.append"))
      this.socket?.send(event);
  }
  inputAudio(pcm24: Buffer, voiced: boolean): void {
    if (voiced) this.lastOwnerAt = this.ports.now();
    if ((this.state !== "live" && this.state !== "capping") || this.input?.push(pcm24) !== false) return;
    this.failed = true;
    this.ports.playback.clear();
    this.close("owner audio buffer overflow");
  }
  private record(seconds: number): void {
    const delta = Math.max(0, seconds - this.recordedSeconds);
    this.recordedSeconds += delta;
    if (delta) this.ports.usage.live(delta);
  }
  private async event(event: LiveEvent): Promise<void> {
    if (this.finalized) return;
    const now = this.ports.now();
    this.commentary.event(event, now);
    switch (event.type) {
      case "session.started":
        if (this.state !== "connecting") return;
        this.state = "live";
        this.startedAt = now;
        this.input = new InputAudio(now);
        this.ports.usage.started();
        this.ports.started();
        this.ports.replies.scan();
        if (this.greet)
          this.send({
            type: "session.commentary.append",
            event_id: randomUUID(),
            delegation_id: null,
            content: `Greet the owner very briefly in their language, then listen.${this.ports.replies.first() ? " Mention an undelivered lead reply; its contents will follow separately." : ""}`,
          });
        this.ports.log("VOICE_SESSION_STARTED");
        break;
      case "session.output_audio.delta": {
        if (this.state !== "live" && this.state !== "capping") return;
        const pcm = Buffer.from(event.delta ?? "", "base64");
        const level = rmsDbfs(pcm);
        if (this.ports.playback.queuedMs() > 200 && level < -55) return;
        if (level > -50 && this.ports.playback.audible) this.commentary.noteAudio(this.ports.playback);
        if (!this.ports.playback.write(pcm)) this.close("provider audio buffer overflow");
        else if (this.ports.playback.audible && level > -50) this.lastOutputAt = now + this.ports.playback.queuedMs();
        break;
      }
      case "session.input_transcript.delta":
        this.inputTranscript.push(event.delta ?? "");
        break;
      case "session.output_transcript.delta":
        this.outputTranscript.push(event.delta ?? "");
        break;
      case "session.delegation.created":
        if (event.delegation && this.state === "live")
          this.backend.created(event.delegation.id, event.delegation.response_id);
        break;
      case "response.event":
        if (event.event?.type === "response.failed")
          this.close(`provider backend failure ${event.event.response?.error?.code ?? "unknown"}`);
        if (event.event) await this.backend.event(event.event, event.delegation_id);
        if (this.state === "live") this.commentary.tick(this.timing());
        break;
      case "session.usage.updated":
        this.record(event.usage?.seconds ?? 0);
        break;
      case "session.closed":
        this.failed ||= this.state !== "closing";
        this.state = "closing";
        this.closingAt ??= now;
        this.persistClosing(event.usage?.seconds ?? this.recordedSeconds);
        this.socket?.close();
        break;
      case "error":
        this.ports.log(`VOICE_PROVIDER_EVENT_ERROR ${event.error?.code ?? "unknown"}`);
        if (
          !event.error?.client_event_id ||
          !["context_injection_incomplete", "context_length_exceeded"].includes(event.error.code ?? "")
        )
          this.close("provider event failure");
        break;
    }
  }
  tick(): void {
    const now = this.ports.now();
    if (this.state === "closed") return;
    if (this.state === "closing") {
      if (now - this.closingAt! > 15_000) this.socket?.terminate();
      return;
    }
    if (this.state === "connecting") {
      if (now - this.openedAt > 30_000) this.close("session start timeout");
      return;
    }
    if (this.startedAt === undefined) return;
    if (now - this.lastRecordedAt >= 1000) {
      // Wall time is a conservative local cap when provider usage events are delayed or the socket is lost.
      this.record((now - this.startedAt) / 1000);
      this.lastRecordedAt = now;
    }
    if (this.state === "live" && this.ports.usage.capReason()) {
      this.send({
        type: "session.instructions.append",
        event_id: randomUUID(),
        delegation_id: null,
        content:
          "Say only that the voice usage limit has been reached and the conversation must continue in text. Then stop.",
      });
      this.state = "capping";
      this.capAt = now;
    }
    if (this.capAt !== undefined && now - this.capAt >= 8000) return void this.close("usage cap");
    for (const pcm of this.input!.drain(now))
      this.send({ type: "session.input_audio.append", audio: pcm.toString("base64") });
    if (this.state !== "live") return;
    if (this.backend.expired()) return void this.close("provider backend stalled");
    if (now - this.lastCommentaryAt >= 1000) {
      if (now - this.lastOutputAt > 1000) this.ports.playback.flushTail();
      this.commentary.tick(this.timing());
      this.lastCommentaryAt = now;
    }
    const quiet = now - Math.max(this.lastOwnerAt, this.startedAt, this.lastOutputAt);
    if (quiet > this.settings.idleCloseSec * 1000 && !this.backend.blocksReply()) this.close("idle");
  }
  private timing() {
    return {
      now: this.ports.now(),
      lastOwnerAt: this.lastOwnerAt,
      lastOutputAt: this.lastOutputAt,
      queuedMs: this.ports.playback.queuedMs(),
      playbackGeneration: this.ports.playback.generation,
      playedFrames: this.ports.playback.playedFrames,
      audible: this.ports.playback.audible,
    };
  }
  private persistClosing(seconds?: number): void {
    try {
      if (seconds === undefined) this.commentary.close(this.timing());
      else this.record(seconds);
    } catch {
      this.failed = true;
      this.ports.log("VOICE_CLOSE_PERSIST_FAILED");
    }
  }
  close(reason: string): void {
    this.failed ||= reason.startsWith("provider") || reason === "session start timeout";
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    this.closingAt = this.ports.now();
    this.persistClosing();
    this.ports.log(`VOICE_SESSION_CLOSING ${reason}`);
    if (!this.socket) return void this.finish();
    try {
      if (this.startedAt !== undefined) this.socket.send({ type: "session.close", event_id: randomUUID() });
      else this.socket.terminate();
    } catch {
      this.socket.terminate();
    }
  }
  private async finish(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.state = "closed";
    this.input = undefined;
    try {
      if (this.startedAt !== undefined) this.persistClosing((this.ports.now() - this.startedAt) / 1000);
      this.persistClosing();
      await Promise.allSettled([...this.tasks]);
      await this.ports.finished(this);
      this.completion.resolve();
    } catch (error) {
      this.completion.reject(error);
    }
  }
}

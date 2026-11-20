import { downTo24kMono, rmsDbfs } from "./audio.ts";
import { VoiceSession } from "./session.ts";
import type { VoiceSessionPorts } from "./types.ts";
import type { VoiceSettings } from "./settings.ts";

/** No connection or timer is created by importing this module. The Discord owner drives all sessions. */
export class VoiceAssistant {
  private current: VoiceSession | undefined;
  private present = false;
  private stopping = false;
  private halted = false;
  private voicedMs = 0;
  private preroll: { pcm: Buffer; voiced: boolean }[] = [];
  private prerollBytes = 0;
  private notice: string | undefined;
  private readonly finishing = new Set<Promise<void>>();

  constructor(
    private readonly settings: VoiceSettings,
    private readonly ports: Omit<VoiceSessionPorts, "started" | "finished"> & {
      summarize(session: VoiceSession): Promise<void>;
      notify(text: string): Promise<void>;
    },
  ) {}

  ownerPresence(present: boolean): void {
    if (this.present === present || this.stopping) return;
    this.present = present;
    if (present) this.start(true);
    else {
      this.preroll = [];
      this.prerollBytes = this.voicedMs = 0;
      this.current?.close("owner left");
    }
  }

  pcm(pcm48: Buffer): void {
    if (!this.present || this.stopping || this.halted) return;
    const pcm = downTo24kMono(pcm48);
    const voiced = rmsDbfs(pcm) > this.settings.wakeRmsDbfs;
    this.voicedMs = voiced ? this.voicedMs + pcm.length / 48 : 0;
    if (this.voicedMs >= 400 && this.ports.playback.queuedMs() > 400) this.ports.playback.clear();
    if (this.current?.state === "live" || this.current?.state === "capping") {
      this.current.inputAudio(pcm, voiced);
      return;
    }
    this.preroll.push({ pcm, voiced });
    this.prerollBytes += pcm.length;
    while (this.prerollBytes > 120_000) this.prerollBytes -= this.preroll.shift()!.pcm.length;
    if (!this.current && this.voicedMs >= 200) this.start(false);
  }

  private start(greet: boolean): void {
    if (this.current || !this.present || this.stopping || this.halted) return;
    const reason = this.ports.usage.capReason();
    if (reason) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: this.settings.timeZone }).format(this.ports.now());
      if (this.notice !== day) {
        this.notice = day;
        this.track(this.ports.notify(`${reason}. Voice will not start; continue in text.`));
      }
      return;
    }
    const current = new VoiceSession(
      this.settings,
      {
        ...this.ports,
        started: () => {
          if (this.current !== current || !this.present || this.stopping) {
            current.close("owner left");
            return;
          }
          for (const chunk of this.preroll) current.inputAudio(chunk.pcm, chunk.voiced);
          this.preroll = [];
          this.prerollBytes = 0;
        },
        finished: async (session) => {
          // Keep admission closed until provider accounting and Discord delivery have settled.
          if (this.current === session) this.ports.playback.clear();
          if (session.failed) {
            this.halted = true;
            await this.ports.notify(
              "Voice stopped after a provider or local safety failure. Voice is held; inspect the error and restart explicitly. No automatic paid retry.",
            );
          }
          await this.ports.summarize(session);
          this.halted ||= session.failed;
          if (this.current === session) this.current = undefined;
        },
      },
      greet,
    );
    this.current = current;
    this.track(current.done);
    try {
      current.open();
    } catch {
      this.halted = true;
      current.close("provider connection failure");
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch(() => {
      this.halted = true;
      this.ports.log("VOICE_FINALIZATION_FAILED");
      this.current?.close("provider or ledger failure");
    });
    this.finishing.add(tracked);
    void tracked.finally(() => this.finishing.delete(tracked));
  }

  tick(): void {
    try {
      this.current?.tick();
    } catch {
      this.halted = true;
      this.ports.log("VOICE_TICK_FAILED");
      this.current?.close("provider or ledger failure");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.present = false;
    this.current?.close("shutdown");
    await Promise.all([...this.finishing]);
  }
}

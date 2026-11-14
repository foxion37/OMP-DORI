import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processIdentity } from "../src/update/deployment-process.ts";
import type { MonitorSpec, RuntimeHealth } from "../src/update/deployment-types.ts";
import type { Monitors } from "./monitor.ts";

type State = {
  readonly stateDir: string;
  readonly paneId: string;
  readonly role: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly wanted: ReadonlyMap<string, MonitorSpec>;
  readonly presetLoaded: boolean;
};
const source = dirname(realpathSync(import.meta.dir));
const extensionHash = createHash("sha256")
  .update(readFileSync(join(source, "extension", "index.ts")))
  .digest("hex");

/** Observes actual children every second; expected release labels are never accepted as health evidence. */
export class RuntimeHealthWriter {
  #state: State | undefined;
  #timer: Timer | undefined;
  readonly #monitors: Monitors;

  constructor(monitors: Monitors) {
    this.#monitors = monitors;
  }

  update(state: State): void {
    this.#state = state;
    this.#write();
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#write(), 1_000);
      this.#timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    const state = this.#state;
    this.#state = undefined;
    if (!state) return;
    const path = join(state.stateDir, "runtime", `${encodeURIComponent(state.paneId)}.json`);
    try {
      const old = JSON.parse(readFileSync(path, "utf8")) as RuntimeHealth;
      if (old.pid === process.pid && old.sessionId === state.sessionId) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #write(): void {
    const state = this.#state;
    if (!state) return;
    const monitors = this.#monitors.list().flatMap((running) => {
      const spec = state.wanted.get(running.name);
      const identity = processIdentity(running.pid);
      return spec && identity
        ? [{ ...spec, argv: running.argv, filter: running.filter, pid: running.pid, startTicks: identity.startTicks }]
        : [];
    });
    const health: RuntimeHealth = {
      version: 1,
      paneId: state.paneId,
      pid: process.pid,
      sessionId: state.sessionId,
      role: state.role,
      presetLoaded: state.presetLoaded,
      startedAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      source,
      extensionHash,
      monitors,
    };
    const path = join(state.stateDir, "runtime", `${encodeURIComponent(state.paneId)}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(health), { mode: 0o600 });
    renameSync(temporary, path);
  }
}

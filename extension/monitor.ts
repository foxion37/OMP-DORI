/**
 * Persistent monitors for the Dori session: a command runs in the background (argv, never a shell) and every
 * stdout/stderr line matching its filter wakes the session. This is the "your monitor tool" the Dori setup
 * expects; omp has no built-in equivalent.
 */
import type { Subprocess } from "bun";

/** Lines arriving within this window after the first one are delivered together. */
export const BATCH_MS = 300;
/** A burst longer than this is split so one message never grows unbounded. */
const BATCH_MAX_LINES = 100;

type Running = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: RegExp;
  readonly cwd: string;
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Session the monitor was started in; its lines are delivered only while that session is current. */
  readonly session: string;
  stopped: boolean;
};

export type MonitorInfo = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly pid: number;
  readonly cwd: string;
};

export class Monitors {
  readonly #running = new Map<string, Running>();
  #pending: Array<{ readonly session: string; readonly text: string }> = [];
  #timer: Timer | undefined;
  readonly #deliver: (content: string) => void;
  readonly #currentSession: () => string | undefined;
  readonly #batchMs: number;

  constructor(deliver: (content: string) => void, currentSession: () => string | undefined, batchMs = BATCH_MS) {
    this.#deliver = deliver;
    this.#currentSession = currentSession;
    this.#batchMs = batchMs;
  }

  start(name: string, argv: readonly string[], filter: string, cwd: string, session: string): MonitorInfo {
    if (!name) throw new Error("monitor name is required");
    if (this.#running.has(name)) throw new Error(`monitor "${name}" is already running; stop it first`);
    if (argv.length === 0) throw new Error("argv must name the command to run");
    const pattern = new RegExp(filter);
    const proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const entry: Running = { name, argv: [...argv], filter: pattern, cwd, proc, session, stopped: false };
    this.#running.set(name, entry);
    void Promise.all([this.#pump(entry, proc.stdout), this.#pump(entry, proc.stderr), proc.exited]).then(
      ([, , code]) => {
        if (this.#running.get(name) === entry) this.#running.delete(name);
        if (entry.stopped) return;
        this.#queue(
          entry,
          `[${name}] monitor exited (${proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`}): ${argv.join(" ")}`,
        );
      },
    );
    return { name, argv: entry.argv, filter, cwd, pid: proc.pid };
  }

  stop(name: string): boolean {
    const entry = this.#running.get(name);
    if (!entry) return false;
    entry.stopped = true;
    entry.proc.kill();
    this.#running.delete(name);
    return true;
  }

  list(): MonitorInfo[] {
    return [...this.#running.values()].map((entry) => ({
      name: entry.name,
      argv: entry.argv,
      filter: entry.filter.source,
      pid: entry.proc.pid,
      cwd: entry.cwd,
    }));
  }

  /** Session end: kill every monitor and drop undelivered lines, which belong to the session that is going away. */
  stopAll(): void {
    for (const name of [...this.#running.keys()]) this.stop(name);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
  }

  async #pump(entry: Running, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) this.#line(entry, line.replace(/\r$/, ""));
    }
    rest += decoder.decode();
    if (rest) this.#line(entry, rest);
  }

  #line(entry: Running, line: string): void {
    if (!entry.stopped && entry.filter.test(line)) this.#queue(entry, `[${entry.name}] ${line}`);
  }

  #queue(entry: Running, text: string): void {
    this.#pending.push({ session: entry.session, text });
    if (this.#pending.length >= BATCH_MAX_LINES) this.#flush();
    else this.#timer ??= setTimeout(() => this.#flush(), this.#batchMs);
  }

  #flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const current = this.#currentSession();
    const lines = this.#pending.filter((line) => line.session === current).map((line) => line.text);
    this.#pending = [];
    if (lines.length > 0) this.#deliver(lines.join("\n"));
  }
}

export const MONITOR_DESCRIPTION = [
  "Persistent background monitors for this Dori session.",
  'op "start" runs `argv` (an argument array, never a shell string) in the session cwd and reads its stdout and stderr line by line. Every line matching the `filter` regular expression wakes this session as a message `[name] line`; lines arriving together are delivered in one message. When a monitor process exits on its own, that is reported the same way; restarting it is your decision.',
  'op "stop" kills the monitor `name` and forgets it. op "list" shows running monitors. Names are unique: starting a running name fails.',
  "Started monitors are recorded in this session. Their processes stop when omp exits, and when the session is resumed (herdr restoring it after a restart, or `omp --resume`) every monitor that was not stopped is started again and announced as `[monitor] restored ...`; you do not need to start them again.",
].join("\n");

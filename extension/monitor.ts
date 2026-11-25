/**
 * Persistent monitors for the Cataly session: a command runs in the background (argv, never a shell) and every
 * matching stdout/stderr line is delivered. Known routine notices wait for the next turn; other output wakes
 * the session. This is the "your monitor tool" the Cataly setup expects; omp has no built-in equivalent.
 */
import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { discordNativeBinary } from "../src/native-binary.ts";
import {
  ASK_RELAY_PROTOCOL,
  ASK_RELAY_STATE,
  routeAskRelay,
} from "../skills/cataly-mode/scripts/src/messenger/discord-ask-relay.ts";
import {
  HEAD_ADMISSION_PROTOCOL,
  isHeadAdmissionProtocol,
} from "../skills/cataly-mode/scripts/src/messenger/head-admission-protocol.ts";
import { monitorPolicy } from "../src/update/monitor-policy.ts";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import type { HeadAdmissions } from "./head-admission.ts";
import { MonitorOutputFile, readMonitorOutput } from "./monitor-output";

/** Lines arriving within this window after the first one are delivered together. */
export const BATCH_MS = 300;
/** A burst longer than this is split so one message never grows unbounded. */
const BATCH_MAX_LINES = 100;
const BATCH_MAX_BYTES = 64 * 1024;
const ROUTINE_NOTICE =
  /^(?:(?:LANE_WATCH_READY|HOST_GUARD_READY|PRESENCE_READY|PRESENCE_ACK|PENDING-REPORT)(?:\s|$)|NUDGED\s.*, delivery delivered\s*$)/;

/** Operational retry/silence notices bound displayed names so they never depend on spill storage. */
const noticeName = (name: string): string => `${name.slice(0, 256)}${name.length > 256 ? "..." : ""}`;

export type MonitorExit = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: string;
  readonly error?: string;
  readonly restartAttempt?: number;
  readonly exhausted?: boolean;
};
type MonitorOptions = Pick<MonitorSpec, "mode" | "restart" | "silentAfterMin"> & {
  readonly recordId?: string;
  readonly restartAttempt?: number;
  readonly onExit?: (result: MonitorExit) => unknown;
};

type Running = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: RegExp;
  readonly cwd: string;
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Session the monitor was started in; its lines are delivered only while that session is current. */
  readonly session: string;
  readonly signal: AbortSignal;
  readonly restart?: MonitorSpec["restart"];
  readonly options: MonitorOptions;
  readonly askState: string | undefined;
  stopped: boolean;
  admitting: boolean;
  /** A daemon between exit and its scheduled retry: recorded intent, not a live child. */
  waiting: boolean;
  restartAttempt: number;
  restartTimer?: Timer | undefined;
  silentTimer?: Timer | undefined;
  backoffUntil?: string | undefined;
  lastData: number;
  prepared?: {
    readonly epoch: number;
    readonly headFile: string;
    readonly identity: unknown;
    readonly fingerprint: unknown;
    readonly content: unknown;
  };
};

export type MonitorInfo = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly pid: number;
  readonly cwd: string;
  readonly restart?: MonitorSpec["restart"];
  readonly mode?: MonitorSpec["mode"];
  readonly silentAfterMin?: number;
  readonly recordId?: string;
  readonly restartAttempt?: number;
  readonly backoffUntil?: string;
  readonly waiting?: boolean;
};

export type MonitorDelivery = {
  readonly wake: boolean;
  readonly session: string;
  readonly signal: AbortSignal;
  readonly details?: unknown;
  isCurrent(): boolean;
};
type Deliver = (content: string, delivery: MonitorDelivery) => unknown;

export class Monitors {
  readonly #running = new Map<string, Running>();
  readonly #restarts = new Map<string, { entry: Running; timer: Timer }>();
  #pending: Array<{ readonly entry: Running; readonly text: string; readonly wake: boolean }> = [];
  #timer: Timer | undefined;
  #pendingBytes = 0;
  #generation = new AbortController();
  #admissionEpoch = 0;
  #flight: Promise<void> | undefined;
  readonly #deliver: Deliver;
  readonly #admissions: HeadAdmissions | undefined;
  readonly #currentSession: () => string | undefined;
  readonly #batchMs: number;
  readonly #restartMs: number;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    deliver: Deliver,
    currentSession: () => string | undefined,
    batchMs = BATCH_MS,
    restart: number | HeadAdmissions = 5_000,
    env: NodeJS.ProcessEnv = process.env,
    private readonly routingState?: () => string | undefined,
  ) {
    this.#deliver = deliver;
    this.#currentSession = currentSession;
    this.#batchMs = batchMs;
    this.#restartMs = typeof restart === "number" ? restart : 5_000;
    this.#admissions = typeof restart === "number" ? undefined : restart;
    this.#env = env;
  }

  start(
    name: string,
    argv: readonly string[],
    filter: string,
    cwd: string,
    session: string,
    options: MonitorOptions | "on-failure" = {},
  ): MonitorInfo {
    if (!name) throw new Error("monitor name is required");
    if (this.#running.has(name) || this.#restarts.has(name))
      throw new Error(`monitor "${name}" is already running or waiting to restart; stop it first`);
    return this.#spawn(
      { name, argv, filter, cwd },
      session,
      0,
      typeof options === "string" ? { restart: options } : options,
    );
  }

  #spawn(
    { name, argv, filter, cwd }: MonitorSpec,
    session: string,
    attempt: number,
    options: MonitorOptions,
  ): MonitorInfo {
    const { restart, mode, recordId } = options;
    if (argv.length === 0) throw new Error("argv must name the command to run");
    const policy = monitorPolicy(options);
    const daemonRestart =
      policy.mode === "daemon" && policy.restart !== undefined && policy.restart !== "on-failure"
        ? policy.restart
        : undefined;
    const firstAttempt = options.restartAttempt ?? 0;
    if (
      !Number.isSafeInteger(firstAttempt) ||
      firstAttempt < 0 ||
      firstAttempt > (daemonRestart ? daemonRestart.max : 0)
    )
      throw new Error("invalid daemon restart attempt");
    const pattern = new RegExp(filter);
    const env = this.#env;
    const state = this.routingState?.();
    const askState = this.#admissions && state && discordNativeBinary() ? resolve(state) : undefined;
    let entry: Running;
    const proc = Bun.spawn([...argv], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(this.#admissions
        ? {
            env: {
              ...env,
              CATALY_MONITOR_ADMISSION: "1",
              CATALY_MONITOR_ADMISSION_PROTOCOL: HEAD_ADMISSION_PROTOCOL,
              [ASK_RELAY_STATE]: askState ?? "",
            },
            serialization: "json" as const,
            ipc: (message: unknown) => this.#ipc(entry, message),
          }
        : { env }),
    });
    entry = {
      name,
      argv: [...argv],
      filter: pattern,
      cwd,
      proc,
      session,
      signal: this.#generation.signal,
      stopped: false,
      admitting: false,
      waiting: false,
      restartAttempt: firstAttempt,
      lastData: performance.now(),
      restart,
      options,
      askState,
    };
    this.#running.set(name, entry);
    this.#silence(entry);
    const finish = proc.exited.then((code) => {
      this.#admissions?.stop(proc.pid);
      clearTimeout(entry.silentTimer);
      entry.silentTimer = undefined;
      // An exited daemon is recorded intent while its output drains, never a live health PID.
      if (daemonRestart) entry.waiting = true;
      return code;
    });
    let previous = attempt;
    const startedAt = performance.now();
    const exited =
      restart === "on-failure"
        ? finish.then((code) => {
            // Only time spent running the child resets a failure streak, not blocked output delivery.
            if (performance.now() - startedAt >= 60_000) previous = 0;
            return code;
          })
        : finish;
    void Promise.all([this.#pump(entry, proc.stdout, "stdout"), this.#pump(entry, proc.stderr, "stderr"), exited])
      .then(async ([, , code]) => {
        if (this.#running.get(name) !== entry) return;
        const retryable = restart === "on-failure" && (code !== 0 || Boolean(proc.signalCode));
        if ((mode === "once" || mode === "daemon" || retryable) && !entry.stopped && this.#current(entry)) {
          // Do not seal or replace the child until the output from this incarnation has drained.
          await this.#flush();
          if (this.#running.get(name) !== entry) return;
        }
        if (entry.stopped || !this.#current(entry)) return;
        if (daemonRestart) {
          const retry = entry.restartAttempt < daemonRestart.max;
          if (retry) entry.restartAttempt++;
          entry.waiting = retry;
          if (!retry) this.#running.delete(name);
          const recorded = await this.#recordExit(entry, code, undefined, {
            restartAttempt: entry.restartAttempt,
            exhausted: !retry,
          });
          const current = this.#running.get(name);
          if (entry.stopped || (current !== undefined && current !== entry)) return;
          if (!this.#current(entry)) {
            if (current === entry) this.stop(name);
            return;
          }
          await this.#queue(
            entry,
            `[${name}] monitor exited (${proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`}): ${argv.join(" ")}`,
          );
          if (!retry) {
            await this.#queue(
              entry,
              `[monitor] ${noticeName(name)} restart limit reached (${daemonRestart.max}); stopped`,
            );
            return;
          }
          if (entry.stopped || this.#running.get(name) !== entry) return;
          if (!recorded || !this.#current(entry)) {
            this.stop(name);
            return;
          }
          this.#daemonTimer(entry, daemonRestart, code);
          return;
        }
        await this.#recordExit(entry, code);
        if (entry.stopped || !this.#current(entry) || this.#running.get(name) !== entry) return;
        this.#running.delete(name);
        if (retryable && this.#scheduleRestart(entry, previous)) return;
        await this.#queue(
          entry,
          `[${name}] monitor exited (${proc.signalCode ? `signal ${proc.signalCode}` : `code ${code}`}): ${argv.join(" ")}`,
        );
      })
      .catch(async (error: unknown) => {
        if (entry.stopped || !this.#current(entry)) return;
        entry.stopped = true;
        this.#admissions?.stop(proc.pid);
        entry.proc.kill();
        if (this.#running.get(name) === entry) this.#running.delete(name);
        await this.#recordExit(
          entry,
          proc.exitCode,
          String(error),
          daemonRestart
            ? { restartAttempt: entry.restartAttempt, exhausted: entry.restartAttempt >= daemonRestart.max }
            : undefined,
        );
        await this.#queue(
          entry,
          `[monitor] output failed for name=${JSON.stringify(name.slice(0, 256))}${name.length > 256 ? "..." : ""} pid=${proc.pid}; stopped; raw output may be incomplete: ${String(error).slice(0, 2048)}`,
        );
      })
      .catch((error: unknown) => console.error("monitor failure reporting failed", error));
    return {
      name,
      argv: entry.argv,
      filter,
      cwd,
      pid: proc.pid,
      ...(restart ? { restart } : {}),
      ...(mode ? { mode } : {}),
      ...(policy.silentAfterMin !== undefined ? { silentAfterMin: policy.silentAfterMin } : {}),
      ...(recordId ? { recordId } : {}),
      ...(daemonRestart ? { restartAttempt: firstAttempt } : {}),
    };
  }

  async #recordExit(
    entry: Running,
    code: number | null,
    error?: string,
    daemon?: { readonly restartAttempt: number; readonly exhausted: boolean },
  ): Promise<boolean> {
    try {
      const result = await entry.options.onExit?.({
        code,
        signal: entry.proc.signalCode === null ? null : String(entry.proc.signalCode),
        at: new Date().toISOString(),
        ...(error === undefined ? {} : { error }),
        ...(daemon === undefined ? {} : daemon),
      });
      return result !== false;
    } catch (cause) {
      await this.#queue(
        entry,
        `[monitor] exit state was not recorded for name=${JSON.stringify(entry.name.slice(0, 256))}; a future resume may restart it: ${String(cause).slice(0, 2048)}`,
      );
      return false;
    }
  }

  /** A daemon retry waits out exponential backoff as recorded intent; it is never a live health PID. */
  #daemonTimer(entry: Running, restart: { readonly max: number; readonly backoffSec: number }, code: number): void {
    const delay = Math.min(2_147_483_647, restart.backoffSec * 1000 * 2 ** (entry.restartAttempt - 1));
    entry.backoffUntil = new Date(Date.now() + delay).toISOString();
    entry.restartTimer = setTimeout(() => {
      if (entry.stopped || this.#running.get(entry.name) !== entry) return;
      if (!this.#current(entry)) {
        this.stop(entry.name);
        return;
      }
      entry.restartTimer = undefined;
      entry.backoffUntil = undefined;
      try {
        const { name, argv, filter, cwd, options, session } = entry;
        this.#spawn({ name, argv, filter: filter.source, cwd }, session, 0, {
          ...options,
          restartAttempt: entry.restartAttempt,
        });
        void this.#queue(
          entry,
          `[monitor] ${noticeName(name)} restarted (exit ${code}, attempt ${entry.restartAttempt}/${restart.max})`,
        ).catch((error: unknown) => console.error("monitor restart notice failed", error));
      } catch (error) {
        this.stop(entry.name);
        void this.#recordExit(entry, null, `restart failed: ${String(error)}`, {
          restartAttempt: entry.restartAttempt,
          exhausted: entry.restartAttempt >= restart.max,
        });
        void this.#queue(
          entry,
          `[monitor] ${noticeName(entry.name)} restart failed; stopped: ${String(error).slice(0, 2048)}`,
        ).catch((reportError: unknown) => console.error("monitor restart reporting failed", reportError));
      }
    }, delay);
  }

  /** One MONITOR_SILENT alert per quiet spell; any raw byte rearms it, and silence never kills the child. */
  #silence(entry: Running): void {
    const minutes = entry.options.silentAfterMin;
    if (!minutes || entry.silentTimer || entry.stopped || entry.waiting) return;
    const threshold = minutes * 60_000;
    entry.silentTimer = setTimeout(
      () => {
        entry.silentTimer = undefined;
        if (entry.stopped || entry.waiting || !this.#current(entry)) return;
        if (performance.now() - entry.lastData < threshold) this.#silence(entry);
        else
          void this.#queue(entry, `[monitor] MONITOR_SILENT ${noticeName(entry.name)} ${minutes}m`).catch(
            (error: unknown) => console.error("monitor silence notice failed", error),
          );
      },
      Math.max(1, threshold - (performance.now() - entry.lastData)),
    );
  }

  #scheduleRestart(entry: Running, previous: number): boolean {
    if (previous >= 3) return false;
    const timer = setTimeout(() => {
      if (this.#restarts.get(entry.name)?.entry !== entry) return;
      this.#restarts.delete(entry.name);
      if (entry.stopped || !this.#current(entry)) return;
      try {
        const { name, argv, filter, cwd, options, session } = entry;
        this.#spawn({ name, argv, filter: filter.source, cwd }, session, previous + 1, options);
      } catch (error) {
        void this.#queue(entry, `[${entry.name}] monitor restart failed: ${String(error).slice(0, 1024)}`).catch(
          (reportError: unknown) => console.error("monitor restart reporting failed", reportError),
        );
      }
    }, this.#restartMs);
    this.#restarts.set(entry.name, { entry, timer });
    return true;
  }

  /** Live and scheduled specifications, without mistaking a scheduled retry for a live child. */
  specs(): Array<MonitorSpec & { readonly recordId?: string }> {
    return [...this.#running.values(), ...Array.from(this.#restarts.values(), ({ entry }) => entry)].map(
      ({ name, argv, filter, cwd, restart, options }) => ({
        name,
        argv,
        filter: filter.source,
        cwd,
        ...(restart ? { restart } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.silentAfterMin !== undefined ? { silentAfterMin: options.silentAfterMin } : {}),
        ...(options.recordId ? { recordId: options.recordId } : {}),
      }),
    );
  }

  stop(name: string): boolean {
    const restart = this.#restarts.get(name);
    if (restart) {
      restart.entry.stopped = true;
      clearTimeout(restart.timer);
      this.#restarts.delete(name);
      return true;
    }
    const entry = this.#running.get(name);
    if (!entry) return false;
    entry.stopped = true;
    clearTimeout(entry.restartTimer);
    clearTimeout(entry.silentTimer);
    this.#admissions?.stop(entry.proc.pid);
    entry.proc.kill();
    this.#running.delete(name);
    return true;
  }

  /** Health callers see only live children; lifecycle callers can include pending daemon backoff. */
  list(includeWaiting = false): MonitorInfo[] {
    return [...this.#running.values()]
      .filter((entry) =>
        entry.waiting ? includeWaiting : entry.proc.exitCode === null && entry.proc.signalCode === null,
      )
      .map((entry) => ({
        name: entry.name,
        argv: entry.argv,
        filter: entry.filter.source,
        pid: entry.proc.pid,
        cwd: entry.cwd,
        ...(entry.restart ? { restart: entry.restart } : {}),
        ...(entry.options.mode ? { mode: entry.options.mode } : {}),
        ...(entry.options.silentAfterMin !== undefined ? { silentAfterMin: entry.options.silentAfterMin } : {}),
        ...(entry.options.recordId ? { recordId: entry.options.recordId } : {}),
        ...(entry.options.mode === "daemon" ? { restartAttempt: entry.restartAttempt } : {}),
        ...(entry.backoffUntil ? { backoffUntil: entry.backoffUntil } : {}),
        ...(entry.waiting ? { waiting: true } : {}),
      }));
  }

  /** Session end: kill every monitor and drop undelivered lines, which belong to the session that is going away. */
  stopAll(): void {
    this.#generation.abort();
    this.#generation = new AbortController();
    this.invalidateAdmissions();
    for (const name of [...this.#running.keys()]) this.stop(name);
    for (const name of this.#restarts.keys()) this.stop(name);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  /** A branch/tree change invalidates pending native handoffs without stopping ordinary monitors. */
  invalidateAdmissions(): void {
    this.#admissionEpoch++;
    this.#admissions?.stop();
  }

  #ipc(entry: Running, raw: unknown): void {
    const admissions = this.#admissions;
    const epoch = this.#admissionEpoch;
    const sourceIsRunning = () =>
      !entry.stopped &&
      entry.proc.exitCode === null &&
      entry.proc.signalCode === null &&
      this.#running.get(entry.name) === entry;
    const isCurrent = () => epoch === this.#admissionEpoch && sourceIsRunning() && this.#current(entry);
    if (!admissions || !sourceIsRunning() || raw === null || typeof raw !== "object" || !("protocol" in raw)) return;
    if (raw.protocol === ASK_RELAY_PROTOCOL) {
      const ownsAskState = () => {
        const current = this.routingState?.();
        return current !== undefined && resolve(current) === entry.askState && isCurrent();
      };
      routeAskRelay(raw, entry.askState, ownsAskState, (reply) => {
        if (!sourceIsRunning()) return;
        try {
          entry.proc.send(reply);
        } catch (error) {
          if (sourceIsRunning()) console.error("ASK supervision reply failed", error);
        }
      });
      return;
    }
    if (!isHeadAdmissionProtocol(raw.protocol)) return;
    const fail = () => {
      entry.admitting = false;
      if (!sourceIsRunning()) return;
      entry.stopped = true;
      admissions.stop(entry.proc.pid);
      this.#running.delete(entry.name);
      entry.proc.kill();
      void this.#queue(entry, `[monitor] ${entry.name} native admission failed; intake state retained`).catch(
        (error: unknown) => console.error("monitor admission failure reporting failed", error),
      );
    };
    if (!isCurrent()) {
      delete entry.prepared;
      if (
        !("request" in raw) ||
        typeof raw.request !== "string" ||
        raw.request.length === 0 ||
        raw.request.length > 64
      ) {
        fail();
        return;
      }
      try {
        entry.proc.send({ protocol: raw.protocol, request: raw.request, outcome: "unresolved" });
      } catch {
        fail();
      }
      return;
    }
    if (entry.admitting) {
      fail();
      return;
    }
    // A prepared delivery is single-use and belongs to this child, source and head activation.
    const prepared = entry.prepared;
    delete entry.prepared;
    if (
      "op" in raw &&
      raw.op === "dispatch" &&
      (!prepared ||
        prepared.epoch !== epoch ||
        !("headFile" in raw) ||
        raw.headFile !== prepared.headFile ||
        !("identity" in raw) ||
        raw.identity !== prepared.identity ||
        !("fingerprint" in raw) ||
        raw.fingerprint !== prepared.fingerprint ||
        !("content" in raw) ||
        raw.content !== prepared.content)
    ) {
      fail();
      return;
    }
    entry.admitting = true;
    void admissions
      .receive(raw, {
        source: entry.proc.pid,
        session: entry.session,
        isCurrent,
        accepts(content) {
          if (!isCurrent()) throw new Error("inactive head source");
          return content.split("\n").some((line) => entry.filter.test(line));
        },
        deliver: async (content, details) => {
          if (!isCurrent()) throw new Error("inactive head source");
          await this.#flush(async () => {
            if (!isCurrent()) throw new Error("inactive head source");
            const text = content
              .split("\n")
              .map((line) => `[${entry.name}] ${line}`)
              .join("\n");
            await this.#deliver(this.#bounded(entry, text), {
              wake: true,
              session: entry.session,
              signal: entry.signal,
              isCurrent,
              details,
            });
          });
          if (!isCurrent()) throw new Error("inactive head source");
        },
      })
      .then((reply) => {
        entry.admitting = false;
        if (isCurrent() && reply.outcome === "ready" && "identity" in raw && "fingerprint" in raw && "content" in raw) {
          entry.prepared = {
            epoch,
            headFile: reply.headFile,
            identity: raw.identity,
            fingerprint: raw.fingerprint,
            content: raw.content,
          };
        }
        if (sourceIsRunning())
          entry.proc.send(
            isCurrent() ? reply : { protocol: reply.protocol, request: reply.request, outcome: "unresolved" },
          );
      })
      .catch(fail);
  }

  async #pump(entry: Running, stream: ReadableStream<Uint8Array>, source: string): Promise<void> {
    await readMonitorOutput(
      stream,
      (line) => this.#line(entry, line),
      (notice) => (entry.stopped ? undefined : this.#queue(entry, `[${entry.name}] monitor ${source} ${notice}`)),
      () => entry.stopped || !this.#current(entry),
      () => {
        entry.lastData = performance.now();
        this.#silence(entry);
      },
    );
  }

  #current(entry: Running): boolean {
    return (
      !entry.signal.aborted && entry.signal === this.#generation.signal && entry.session === this.#currentSession()
    );
  }

  async #line(entry: Running, line: string): Promise<void> {
    if (!entry.stopped && entry.filter.test(line))
      await this.#queue(entry, `[${entry.name}] ${line}`, !ROUTINE_NOTICE.test(line));
  }

  #bounded(entry: Running, text: string): string {
    const bytes = Buffer.byteLength(text);
    if (bytes > BATCH_MAX_BYTES) {
      const output = new MonitorOutputFile();
      try {
        output.write(Buffer.from(text));
      } finally {
        output.close();
      }
      text = `[monitor] message saved for name=${JSON.stringify(entry.name.slice(0, 256))}${entry.name.length > 256 ? "..." : ""} pid=${entry.proc.pid}: ${bytes} bytes; file=${JSON.stringify(output.path)}`;
    }
    return text;
  }

  async #queue(entry: Running, text: string, wake = true): Promise<void> {
    if (!this.#current(entry)) return;
    if (Buffer.byteLength(text) > BATCH_MAX_BYTES) wake = true;
    text = this.#bounded(entry, text);
    const bytes = Buffer.byteLength(text);
    while (
      this.#pending.length >= BATCH_MAX_LINES ||
      this.#pendingBytes + bytes + (this.#pending.length ? 1 : 0) > BATCH_MAX_BYTES
    ) {
      await this.#flush();
      if (!this.#current(entry)) return;
    }
    this.#pendingBytes += bytes + (this.#pending.length ? 1 : 0);
    this.#pending.push({ entry, text, wake });
    if (this.#pending.length >= BATCH_MAX_LINES || this.#pendingBytes >= BATCH_MAX_BYTES) await this.#flush();
    else
      this.#timer ??= setTimeout(() => {
        void this.#flush().catch((error: unknown) => console.error("monitor flush failed", error));
      }, this.#batchMs);
  }

  async #flush(admit?: () => Promise<void>): Promise<void> {
    const signal = this.#generation.signal;
    while (this.#flight) {
      await this.#flight;
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const lines = this.#pending.filter(({ entry }) => this.#current(entry));
    this.#pending = [];
    this.#pendingBytes = 0;
    const first = lines[0]?.entry;
    if (!first && !admit) return;
    const done = (async () => {
      if (first) {
        const delivery: MonitorDelivery = {
          session: first.session,
          signal: first.signal,
          wake: lines.some((line) => line.wake),
          isCurrent: () => this.#current(first),
        };
        try {
          await this.#deliver(lines.map(({ text }) => text).join("\n"), delivery);
        } catch (error) {
          if (delivery.signal.aborted && error === delivery.signal.reason) return;
          if (!delivery.isCurrent()) {
            console.error("monitor delivery failed after session invalidation", error);
            return;
          }
          const entries = [...new Set(lines.map(({ entry }) => entry))];
          for (const entry of entries) {
            entry.stopped = true;
            this.#admissions?.stop(entry.proc.pid);
            if (this.#running.get(entry.name) === entry) {
              entry.proc.kill();
              this.#running.delete(entry.name);
            }
          }
          const notice = `[monitor] delivery failed for name=${JSON.stringify(first.name.slice(0, 256))}; stopped ${entries.length} monitor(s); raw output may be incomplete: ${String(error).slice(0, 2048)}`;
          try {
            if (delivery.isCurrent()) await this.#deliver(notice, { ...delivery, wake: true });
          } catch (reportError) {
            console.error(notice, reportError);
          }
        }
      }
      await admit?.();
    })();
    // Other writers wait for completion; this caller still receives its own delivery failure.
    const completed = done.catch(() => undefined);
    this.#flight = completed;
    try {
      await done;
    } finally {
      if (this.#flight === completed) this.#flight = undefined;
    }
  }
}

export const MONITOR_DESCRIPTION = [
  "Persistent background monitors for this Cataly session.",
  'mode "once" retains restore intent until the job exits cleanly, output is delivered, and completion is recorded. Managed restarts wait for unfinished once work.',
  'op "start" runs `argv` (an argument array, never a shell string) in the session cwd and reads its stdout and stderr line by line. Matching `filter` lines wake this session as a message `[name] line`; lines arriving together are delivered in one message. Exits are reported unless an explicit `restart: "on-failure"` schedules a retry. That option retries nonzero exits or signals up to three times in a failure streak, after five seconds each. Clean exits are never retried.',
  'mode "daemon" restarts after an exit with bounded exponential backoff: restart {max: 5, backoffSec: 10} by default, at most 100 retries. Exhaustion is a durable stop. An explicit start creates a fresh retry budget; /new resets only unfinished intent. The retry count survives session resume; session restore starts a new process immediately using the retained count. Pending retries are cancelled on stop or session change. A recording or output failure stops automatic retries.',
  "silentAfterMin opts into one MONITOR_SILENT alert per quiet spell, rearmed by any stdout/stderr bytes, including filtered and partial lines. Silence does not restart or kill the child. The interval must be positive and fit the platform timer range.",
  "Lines over 64 KiB are streamed to a private temporary file instead of filtered or truncated. An immediate warning gives its path; completion gives its raw byte count. Batches are limited to 64 KiB including prefixes and separators; an oversized rendered message is preserved in a file too. Read those files for the complete output. They survive monitor stop; remove them only when no longer needed. Storage/read failure stops the monitor and reports potentially incomplete output.",
  'op "stop" kills the monitor `name` and forgets it. op "list" shows running monitors. Names are unique: starting a running name fails.',
  "Started monitors are recorded in this session. Their processes stop when omp exits, and when the session is resumed (`omp --resume`, or a Cataly restart reopening it) every monitor that was not stopped is started again and announced as `[monitor] restored ...`; you do not need to start them again.",
].join("\n");

import { parse } from "../cli-args.ts";
import { runDuty, runLoop } from "../cli-loops.ts";
import { defaultDeps } from "../harness.ts";
import { hooksSettled } from "../hooks.ts";
import type { HeadlessObservation, HeadlessRequest, NativeLoopRole } from "./headless-protocol.ts";
import { type HostStart, type Reservation, serveHost } from "./headless-record.ts";

/** The detached host is itself the plain loop process. No shell, terminal or OMP child is involved. */
class NativeLoop {
  readonly closedSessionId = undefined;
  private readonly stop = new AbortController();
  private running: Promise<number> | undefined;
  private ready = false;

  constructor(
    private readonly reservation: Reservation,
    private readonly role: NativeLoopRole,
  ) {}

  async start(start: HostStart): Promise<number> {
    if (start.argv.length || start.expectedResumeId !== undefined) throw new Error("unexpected native loop argv");
    process.chdir(this.reservation.cwd);
    for (const [key, value] of Object.entries(start.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const d = defaultDeps();
    const run = this.role === "duty-loop" ? runDuty : runLoop;
    const lifecycle = {
      signal: this.stop.signal,
      ready: () => {
        this.ready = true;
        console.log(`${this.role} ready pid=${process.pid}`);
      },
    };
    this.running = run(d, parse([]), undefined, lifecycle);
    try {
      return await this.running;
    } finally {
      await hooksSettled();
      await d.usage.flush(2_000);
    }
  }

  async handle(request: HeadlessRequest): Promise<HeadlessObservation | { readonly stopped: true }> {
    if (request.op === "stop-loop") {
      if (!this.running) throw new Error("native loop startup is not confirmed");
      this.stop.abort();
      await this.running;
      return { stopped: true };
    }
    if (request.op !== "observe") throw new Error("native loop has no OMP session");
    const { ref, cwd, startedAt } = this.reservation;
    return {
      ref,
      cwd,
      startedAt,
      updatedAt: new Date().toISOString(),
      status: this.ready ? (this.stop.signal.aborted ? "unknown" : "working") : "unknown",
      harnessRole: this.role,
      pid: process.pid,
      held: false,
      dialogs: [],
      recent: [],
    };
  }
}

// `bun headless-loop.ts <dir>`: the Bun host for `duty-loop` and `hourly-loop`; agent roles run `cataly headless-host`.
if (import.meta.main) {
  const dir = process.argv[2];
  if (dir)
    await serveHost(dir, (reservation) => {
      const { role } = reservation;
      if (role !== "duty-loop" && role !== "hourly-loop")
        throw new Error("headless-loop.ts serves duty-loop and hourly-loop; agent roles run on the native binary");
      return new NativeLoop(reservation, role);
    });
}

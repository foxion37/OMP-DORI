import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { HeadlessRuntime, type HeadlessObservation } from "../src/runtime/headless.ts";
import type { HeadlessBeginOutcome } from "../src/runtime/headless-launch-model.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type {
  AgentStatus,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Probe,
  SessionInfo,
  SessionRef,
} from "../src/runtime/types.ts";
import { Store, type HostLoad } from "../src/store.ts";
import type { DutyCounts, TelemetryEvent, Usage } from "../src/telemetry.ts";
import { deliverTo, FakeTerminal } from "./fake-terminal.ts";

/** The n-th fake headless session id: a valid UUID, so `headless:<id>` parses like a real native lane. */
export const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A headless ref, the form every test world addresses native sessions by. */
export const href = (id: string): SessionRef => ({ runtime: "headless", id });
/** A Tern block ref: a hand-registered terminal role (the lead of harness-setup.ts) lives in one. */
export const tref = (id: string): SessionRef => ({ runtime: "tern", id });

/** `screen` is what `read` returns; undefined makes the read fail. `env` is what the native start received. */
export type Pane = {
  status: AgentStatus;
  received: string[];
  ran: string[];
  cwd: string;
  screen?: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  sessionId: string;
};

/**
 * The native runtime of a test world: every session lives in `World.panes`, nothing is spawned. It is a
 * HeadlessRuntime, so lane starts and native harness paths take their production branch.
 */
class FakeHeadless extends HeadlessRuntime {
  constructor(
    private readonly w: World,
    stateDir: string,
  ) {
    super(stateDir, {});
  }

  override self(): SessionRef | undefined {
    return undefined;
  }

  override async create(spec: CreateSpec): Promise<SessionRef> {
    this.w.onCreate?.(spec);
    const id = sid(++this.w.next);
    this.w.addPane(id, "idle").cwd = realpathSync(spec.cwd);
    this.w.created.push(spec);
    return { runtime: "headless", id, ...(spec.group === undefined ? {} : { group: spec.group }) };
  }

  override async list(): Promise<readonly SessionInfo[]> {
    return [...this.w.panes]
      .filter(([id]) => !this.w.terminals.has(id))
      .map(([id, pane]) => ({ ref: href(id), status: pane.status }));
  }

  override async observe(ref: SessionRef): Promise<HeadlessObservation> {
    const pane = this.w.panes.get(ref.id);
    return {
      ref,
      cwd: pane?.cwd ?? "",
      startedAt: "",
      updatedAt: "",
      status: pane?.status ?? "gone",
      role: "lane",
      held: false,
      dialogs: [],
      recent: [],
      ...(pane ? { sessionId: pane.sessionId, sessionFile: `/sessions/${ref.id}.jsonl` } : {}),
    };
  }

  override async probe(ref: SessionRef): Promise<Probe> {
    this.w.calls.push({ cmd: "probe", argv: [ref.id] });
    this.w.probeHook.get(ref.id)?.(this.w.calls.filter((c) => c.cmd === "probe" && c.argv[0] === ref.id).length);
    const pane = this.w.panes.get(ref.id);
    return pane
      ? { status: pane.status, shellInFront: false, agent: "omp", sessionId: pane.sessionId }
      : { status: "gone", shellInFront: false };
  }

  override async read(ref: SessionRef): Promise<string> {
    const screen = this.w.panes.get(ref.id)?.screen;
    if (screen === undefined) throw new Error("read failed");
    return screen;
  }

  override async deliver(ref: SessionRef, text: string, options: DeliverOptions = {}): Promise<DeliverOutcome> {
    return deliverTo(this.w, ref, text, options);
  }

  override async close(ref: SessionRef): Promise<void> {
    this.w.calls.push({ cmd: "close", argv: [ref.id] });
    this.w.panes.delete(ref.id);
  }

  override async startNative(
    ref: SessionRef,
    argv: readonly string[],
    overrides: Readonly<Record<string, string | undefined>>,
  ): Promise<HeadlessObservation> {
    const pane = this.w.panes.get(ref.id);
    if (!pane) throw new Error(`no fake session ${ref.id}`);
    pane.ran.push(argv.join(" "));
    pane.env = overrides;
    return this.observe(ref);
  }

  /** A loop controller: recorded as `loop` in `ran`, never spawned. */
  override async startLoop(
    ref: SessionRef,
    overrides: Readonly<Record<string, string | undefined>>,
  ): Promise<HeadlessObservation> {
    return this.startNative(ref, ["loop"], overrides);
  }

  override async begin(ref: SessionRef, expectedSessionId: string, objective: string): Promise<HeadlessBeginOutcome> {
    const pane = this.w.panes.get(ref.id);
    if (!pane || pane.sessionId !== expectedSessionId) throw new Error(`no fake session ${ref.id}`);
    pane.received.push(objective);
    return {
      ...(await this.observe(ref)),
      goal: { status: "active", objective },
      modelReadback: {
        requested: null,
        observed: null,
        status: "unrequested",
        billing: "unknown",
        checkedAt: "",
        source: "native-extension",
      },
    };
  }
}

export class World {
  panes = new Map<string, Pane>();
  /** The ids in `panes` that are Tern blocks; every other id is a headless session. */
  terminals = new Set<string>();
  /** Every CreateSpec the fake runtime received, in order. */
  created: CreateSpec[] = [];
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  next = 100;
  /** session id -> the detail of an ambiguous delivery to it */
  deliverFails = new Map<string, string>();
  /** session id -> called on each probe of it with the probe's 1-based count, before it answers */
  probeHook = new Map<string, (n: number) => void>();
  /** called before each session is created; a throw is the runtime refusing to create it */
  onCreate: ((spec: CreateSpec) => void) | undefined;
  /** a command named `slow-hook` awaits this before answering (a hook that hangs) */
  hang: Promise<void> | undefined;
  /** called when a hanging `slow-hook` is killed; the killed hook then exits 143 */
  onHookKill: (() => void) | undefined;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  usage: TelemetryEvent[] = [];
  dutyCounts: DutyCounts[] = [];
  touches = 0;
  recorder: Usage = {
    touch: () => {
      this.touches++;
    },
    record: (e) => {
      this.usage.push(e);
    },
    duty: (c) => {
      this.dutyCounts.push(c);
    },
    flush: async () => {},
  };
  /** every command other than gh: the reviewer, and lifecycle hooks */
  reviewer: (argv: readonly string[]) => { code: number; stdout: string; stderr?: string } = () => ({
    code: 0,
    stdout: "VERDICT: CLEAR",
  });

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const p: Pane = { status, received: [], ran: [], cwd: "", sessionId: `session-${id}` };
    this.panes.set(id, p);
    return p;
  }

  /** A Tern block: the fake terminal runtime answers for it (a hand-registered role such as the harness lead). */
  addTerminal(id: string, status: AgentStatus = "idle"): Pane {
    this.terminals.add(id);
    return this.addPane(id, status);
  }

  exec: Exec = async (cmd, argv, options) => {
    this.calls.push({ cmd, argv });
    if (cmd === "slow-hook" && this.hang) {
      let killed = false;
      const kill = new Promise<void>((resolve) =>
        options?.onSpawn?.({
          kill: () => {
            killed = true;
            this.onHookKill?.();
            resolve();
          },
        }),
      );
      await Promise.race([this.hang, kill]);
      if (killed) return { code: 143, stdout: "", stderr: "terminated" };
    }
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    return { stderr: "", ...this.reviewer(argv) };
  };

  /**
   * Deps over this world's recorders. New sessions open on the fake native runtime, or on the fake Tern runtime with
   * `runtime: "tern"`; stored refs reach the runtime of their kind. The store root holds a config whose native OMP
   * command passes launch validation; the fake runtimes never run it.
   */
  deps(opts: { readonly runtime?: "headless" | "tern" } = {}): Deps {
    const root = mkdtempSync(join(tmpdir(), "cataly-test-"));
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ agentCommand: ["omp", "--model", "{model}", "{prompt}"], defaultModel: "fixture/model" }),
    );
    const runtime = new FakeHeadless(this, join(root, "state"));
    const terminal = new FakeTerminal(this);
    const selected = opts.runtime ?? "headless";
    return {
      store: new Store(root),
      runtimes: new Runtimes(selected, (kind) => (kind === "tern" ? terminal : runtime)),
      choice: () => ({ kind: selected, source: selected === "tern" ? "config" : "default" }),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omp",
      catalyCmd: "cataly",
      host: () => this.host,
      usage: this.recorder,
    };
  }
}

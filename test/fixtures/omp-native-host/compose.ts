import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
  emitSessionShutdownEvent,
  ExtensionRunner,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
  Extension,
  ExtensionAgentIdentity,
  ExtensionContext,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

type FixtureModel = NonNullable<ExtensionContext["model"]>;

// A complete native Model with no transport implementation, catalog resolution, auth or provider request.
export const SOL_MODEL = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  api: "fixture",
  provider: "openai-codex",
  baseUrl: "http://127.0.0.1:0",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500_000,
  maxTokens: 128_000,
  identity: { class: "unknown" },
  compat: undefined,
} satisfies FixtureModel;

export const nativeComposition = async (
  entries: readonly string[],
  base: string[],
  options: {
    role?: "dori" | "lane";
    model?: FixtureModel;
    agent?: ExtensionAgentIdentity;
    observeBefore?: string;
  },
) => {
  const host = process.env["DORI_TEST_OMP_ROOT"];
  if (!host || !isAbsolute(host)) throw new Error("DORI_TEST_OMP_ROOT must name the absolute exact native OMP fixture");
  const manifest = await Bun.file(join(host, "package.json")).json();
  if (manifest.version !== "18.18.8") throw new Error(`native OMP fixture must be 18.18.8, got ${manifest.version}`);
  const modulePath = import.meta.resolve("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner");
  const resolvedRunner = modulePath.startsWith("file:") ? fileURLToPath(modulePath) : modulePath;
  if (realpathSync(resolvedRunner) !== realpathSync(join(host, "src/extensibility/extensions/runner.ts")))
    throw new Error("native prompt guard imported a host outside DORI_TEST_OMP_ROOT");
  const runtime = new ExtensionRuntime();
  const events = new EventBus();
  const cwd = import.meta.dir;
  const session = SessionManager.inMemory(cwd);
  if (options.role) runtime.flagValues.set("dori-role", options.role);
  const extensions: Extension[] = [];
  const beforeDori: string[][] = [];
  const afterAll: string[][] = [];
  const observe = (name: string, snapshots: string[][]) =>
    loadExtensionFromFactory(
      (api) => {
        api.on("before_agent_start", (event) => {
          snapshots.push([...event.systemPrompt]);
          // Deliberately decline: the real runner must retain the earlier combined winner.
        });
      },
      cwd,
      events,
      runtime,
      name,
    );
  for (const entry of entries) {
    if (entry === options.observeBefore) extensions.push(await observe("before-dori", beforeDori));
    // Entries select the real extension/plugin factories at runtime, including the CI-only pinned dependency.
    const module: { default?: unknown } = await import(entry);
    if (typeof module.default !== "function") throw new Error(`no extension factory at ${entry}`);
    extensions.push(await loadExtensionFromFactory(module.default as ExtensionFactory, cwd, events, runtime, entry));
  }
  extensions.push(await observe("declining-final-handler", afterAll));
  // No auth-backed registry is constructed. Any unexpected registry access fails this guard.
  const registry = new Proxy({} as ModelRegistry, {
    get: (_target, key) => {
      throw new Error(`native prompt fixture unexpectedly accessed the model registry: ${String(key)}`);
    },
  });
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    cwd,
    session,
    registry,
    undefined,
    undefined,
    undefined,
    undefined,
    options.agent,
  );
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  const forbidden = (): never => {
    throw new Error("native prompt fixture attempted an action outside prompt composition");
  };
  let active: string[] = [];
  runner.initialize(
    {
      sendMessage: forbidden,
      sendUserMessage: forbidden,
      appendEntry: (type, data) => void session.appendCustomEntry(type, data),
      setLabel: forbidden,
      getActiveTools: () => [...active],
      getAllTools: () => [],
      setActiveTools: async (names) => {
        active = [...names];
      },
      getCommands: () => [],
      setModel: forbidden,
      getThinkingLevel: () => undefined,
      setThinkingLevel: forbidden,
      getSessionName: () => undefined,
      setSessionName: forbidden,
    },
    {
      getModel: () => options.model ?? SOL_MODEL,
      isIdle: () => true,
      abort: forbidden,
      hasPendingMessages: () => false,
      shutdown: forbidden,
      getContextUsage: () => undefined,
      compact: forbidden,
      getSystemPrompt: () => base,
    },
  );
  try {
    await runner.emit({ type: "session_start" });
    const first = await runner.emitBeforeAgentStart("ulw fix the fixture", undefined, base);
    const second = await runner.emitBeforeAgentStart("ulw fix the fixture", undefined, base);
    return { first: first?.systemPrompt, second: second?.systemPrompt, beforeDori, afterAll };
  } finally {
    await emitSessionShutdownEvent(runner);
    if (errors.length) throw new AggregateError(errors, "native prompt fixture handler failed");
  }
};

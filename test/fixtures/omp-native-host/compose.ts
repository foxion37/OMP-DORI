import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  ExtensionRuntime,
  importExtensionModule,
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
  PreparedExtension,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

type FixtureModel = NonNullable<ExtensionContext["model"]>;

const preparedFactories = new Map<string, Promise<PreparedExtension>>();

async function assertNativeHost(): Promise<void> {
  const host = process.env["DORI_TEST_OMP_ROOT"];
  if (!host || !isAbsolute(host)) throw new Error("DORI_TEST_OMP_ROOT must name the absolute exact native OMP fixture");
  const manifest = await Bun.file(join(host, "package.json")).json();
  if (manifest.version !== "18.20.0") throw new Error(`native OMP fixture must be 18.20.0, got ${manifest.version}`);
  for (const [specifier, path] of [
    ["@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", "src/extensibility/extensions/runner.ts"],
    ["@oh-my-pi/pi-coding-agent/extensibility/extensions/loader", "src/extensibility/extensions/loader.ts"],
    ["@oh-my-pi/pi-coding-agent/config/settings", "src/config/settings.ts"],
  ] as const) {
    const resolved = import.meta.resolve(specifier);
    const modulePath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    if (realpathSync(modulePath) !== realpathSync(join(host, path)))
      throw new Error(`native prompt guard imported ${specifier} outside DORI_TEST_OMP_ROOT`);
  }
}

/** Rebind the same canonically prepared module across parent and subagent sessions, as the native host does. */
export const nativeExtensionFactory = async (entry: string): Promise<ExtensionFactory> => {
  await assertNativeHost();
  const selected = realpathSync(entry);
  let pending = preparedFactories.get(selected);
  if (!pending) {
    pending = importExtensionModule(selected, import.meta.dir);
    preparedFactories.set(selected, pending);
  }
  const prepared = await pending;
  if (!prepared.factory) throw new Error(prepared.error ?? `no extension factory at ${selected}`);
  if (prepared.error) throw new Error(prepared.error);
  return prepared.factory;
};

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
    command?: { name: string; args: string; beforePrompt?: boolean };
  },
) => {
  await assertNativeHost();
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
    const factory = await nativeExtensionFactory(entry);
    extensions.push(await loadExtensionFromFactory(factory, cwd, events, runtime, entry));
  }
  extensions.push(await observe("declining-final-handler", afterAll));
  // No auth-backed registry is constructed. Any unexpected registry access fails this guard.
  const registry = new Proxy({} as ModelRegistry, {
    get: (_target, key) => {
      throw new Error(`native prompt fixture unexpectedly accessed the model registry: ${String(key)}`);
    },
  });
  const settings = Settings.isolated({ "prewalk.auto": "off", "prewalk.enabled": false });
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    cwd,
    session,
    registry,
    undefined,
    settings,
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
  const userMessages: string[] = [];
  runner.initialize(
    {
      sendMessage: forbidden,
      sendUserMessage: options.command
        ? async (content) => {
            if (typeof content !== "string") throw new Error("native command fixture requires a text user message");
            userMessages.push(content);
          }
        : forbidden,
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
  const invokeCommand = async (): Promise<void> => {
    const request = options.command;
    if (!request) return;
    const command = runner.getCommand(request.name);
    if (!command) throw new Error(`no native command ${request.name}`);
    await runner.runScoped(() => command.handler(request.args, runner.createCommandContext()));
  };
  try {
    await runner.emit({ type: "session_start" });
    if (options.command?.beforePrompt) await invokeCommand();
    const first = await runner.emitBeforeAgentStart("ulw fix the fixture", undefined, base);
    const second = await runner.emitBeforeAgentStart("ulw fix the fixture", undefined, base);
    if (options.command && !options.command.beforePrompt) await invokeCommand();
    return {
      firstResult: first,
      secondResult: second,
      first: first?.systemPrompt,
      second: second?.systemPrompt,
      beforeDori,
      afterAll,
      userMessages,
      entries: session.getBranch(),
    };
  } finally {
    try {
      await emitSessionShutdownEvent(runner);
    } finally {
      settings.stopWatching();
      await settings.flush();
    }
    if (errors.length) throw new AggregateError(errors, "native prompt fixture handler failed");
  }
};

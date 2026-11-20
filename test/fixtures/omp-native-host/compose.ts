import { realpathSync } from "node:fs";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  ExtensionRuntime,
  importExtensionModule,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
  Extension,
  ExtensionAgentIdentity,
  ExtensionContext,
  ExtensionFactory,
  PreparedExtension,
  ToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { assertNativeHost } from "./host.ts";

type FixtureModel = NonNullable<ExtensionContext["model"]>;

const preparedFactories = new Map<string, Promise<PreparedExtension>>();

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
    nativePrompt?: boolean;
    customPrompt?: string;
    cwd?: string;
    prompt?: string;
    compact?: boolean;
    activeTools?: string[];
    tools?: Record<string, string>;
    command?: { name: string; args: string; beforePrompt?: boolean };
  },
) => {
  await assertNativeHost();
  const runtime = new ExtensionRuntime();
  const events = new EventBus();
  const cwd = options.cwd ?? import.meta.dir;
  let promptBase = base;
  const session = SessionManager.inMemory(cwd);
  if (options.role) runtime.flagValues.set("dori-role", options.role);
  const extensions: Extension[] = [];
  const beforeDori: string[][] = [];
  const afterAll: string[][] = [];
  let tools: ToolInfo[] = [];
  const observe = (name: string, snapshots: string[][]) =>
    loadExtensionFromFactory(
      (api) => {
        tools = Object.entries(options.tools ?? {}).map(
          ([name, description]): ToolInfo => ({
            name,
            description,
            parameters: api.typebox.Type.Object({}),
            sourceInfo: { path: import.meta.path, source: "sdk", scope: "temporary", origin: "top-level" },
          }),
        );
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
  let active: string[] = [...(options.activeTools ?? [])];
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
      getAllTools: () => tools,
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
      getSystemPrompt: () => promptBase,
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
    if (options.nativePrompt) {
      const model = options.model ?? SOL_MODEL;
      const rendered = await runner.runScoped(() =>
        buildSystemPrompt({
          cwd,
          contextFiles: [],
          noContextFiles: true,
          activeRepoContext: null,
          skills: [],
          rules: [],
          alwaysApplyRules: [],
          personality: "none",
          ...(options.customPrompt === undefined ? {} : { resolvedCustomPrompt: options.customPrompt }),
          model: `${model.provider}/${model.id}`,
          subagent: options.agent?.kind === "sub",
          toolNames: active,
          inlineToolDescriptors: true,
          tools: new Map(tools.map(({ name, description }) => [name, { label: name, description }])),
        }),
      );
      promptBase = [...rendered.systemPrompt, ...base];
    }
    const originalBase = [...promptBase];
    const prompt = options.prompt ?? "ulw fix the fixture";
    const first = await runner.emitBeforeAgentStart(prompt, undefined, promptBase);
    const second = await runner.emitBeforeAgentStart(prompt, undefined, promptBase);
    let postCompaction;
    let compactionMessages: ReadonlyArray<ReturnType<typeof session.buildSessionContext>["messages"]> = [];
    if (options.compact) {
      // Exercise the native persisted-entry and extension hook boundary, not a summary-model request.
      session.appendMessage({ role: "user", content: "History-only role instruction", timestamp: 1 });
      const beforeMessages = session.buildSessionContext().messages;
      const retained = session.appendMessage({ role: "user", content: "Retained fixture request", timestamp: Date.now() });
      const id = session.appendCompaction("Local fixture summary", undefined, retained, 100);
      const entry = session.getEntries().find((value) => value.id === id);
      if (entry?.type !== "compaction") throw new Error("native compaction entry is absent");
      await runner.emit({ type: "session_compact", compactionEntry: entry, fromExtension: false });
      compactionMessages = [beforeMessages, session.buildSessionContext().messages];
      postCompaction = await runner.emitBeforeAgentStart("Continue the existing work.", undefined, promptBase);
    }
    if (options.command && !options.command.beforePrompt) await invokeCommand();
    return {
      base: promptBase,
      originalBase,
      mode: runner.createCommandContext().mode,
      activeTools: active,
      postCompaction,
      firstResult: first,
      secondResult: second,
      first: first?.systemPrompt,
      second: second?.systemPrompt,
      beforeDori,
      afterAll,
      userMessages,
      compactionMessages,
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

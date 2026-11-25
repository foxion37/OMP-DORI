import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent";

import type { CommandOptions as Command, CatalyApi, CatalyContext, ToolDefinition as Tool } from "../index";

export const calls: string[] = [];

export type Entry = {
  id?: string;
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  mode?: string;
  message?: unknown;
  content?: unknown;
};
export type FakeSession = { id: string; file?: string; entries: Entry[] };
type Agent = CatalyContext["agent"];
export type FakeOptions = {
  session: FakeSession;
  flags?: Record<string, string>;
  agent?: Agent;
  mode?: CatalyContext["mode"];
  hasUI?: boolean;
  active?: string[];
  model?: CatalyContext["model"];
  catalog?: NonNullable<CatalyContext["model"]>[];
  subscription?: boolean;
  thinking?: string;
};

export type FakePi = {
  api: CatalyApi;
  handlers: Map<string, Array<(event: unknown, ctx: CatalyContext) => unknown>>;
  commands: Map<string, Command>;
  tools: Map<string, Tool>;
  active: string[];
  messages: Array<{ content: string; options: unknown }>;
  /** Every `sendMessage` with its custom message kind, which `messages` leaves out. */
  sent: Array<{ customType: string; content: string; options: unknown }>;
  userMessages: string[];
  notes: string[];
  statuses: Map<string, string>;
  session: FakeSession;
  /** The agent the next context names; a subagent's context reads its own jobs. */
  agent: Agent;
  /** What `getAsyncJobSnapshot` returns; null is OMP's "no job manager". */
  jobs: AsyncJobSnapshot | null;
  ctx(): CatalyContext;
  /** Runs handlers in registration order, chaining before_agent_start prompt replacements as OMP does. */
  emit(event: string, payload?: unknown): Promise<unknown[]>;
  command(name: string, args?: string): Promise<void>;
};

const schema = { optional: () => schema, describe: () => schema };

export const fakePi = (options: FakeOptions): FakePi => {
  const flags = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
  const fake: FakePi = {
    handlers: new Map(),
    commands: new Map(),
    tools: new Map(),
    active: options.active ?? ["read", "bash"],
    messages: [],
    sent: [],
    userMessages: [],
    notes: [],
    statuses: new Map(),
    session: options.session,
    agent: options.agent ?? { kind: "main", id: "Main" },
    jobs: null,
    ctx: () => ({
      cwd: tmpdir(),
      abort: () => void calls.push("abort"),
      mode: options.mode ?? "print",
      ...(options.hasUI === undefined ? {} : { hasUI: options.hasUI }),
      agent: fake.agent,
      model: options.model,
      modelRegistry: {
        getAvailableForProviders: (providers) =>
          (options.catalog ?? (options.model ? [options.model] : [])).filter(
            (model) => !!model.provider && providers.has(model.provider),
          ),
        isUsingSubscription: () => options.subscription ?? false,
      },
      sessionManager: {
        getSessionId: () => fake.session.id,
        getSessionFile: () => fake.session.file,
        getBranch: () => [...fake.session.entries],
        getEntries: () => [...fake.session.entries],
      },
      ui: {
        notify: (message: string) => void fake.notes.push(message),
        setStatus: (key, text) => {
          if (text === undefined) fake.statuses.delete(key);
          else fake.statuses.set(key, text);
        },
      },
      getAsyncJobSnapshot: () => fake.jobs,
    }),
    emit: async (event, payload = { type: event }) => {
      const results: unknown[] = [];
      let current = payload;
      for (const handler of [...(fake.handlers.get(event) ?? [])]) {
        const result = await handler(current, fake.ctx());
        results.push(result);
        if (
          event === "before_agent_start" &&
          result &&
          typeof result === "object" &&
          "systemPrompt" in result &&
          result.systemPrompt !== undefined
        ) {
          current = {
            ...(typeof current === "object" && current !== null ? current : {}),
            systemPrompt: typeof result.systemPrompt === "string" ? [result.systemPrompt] : result.systemPrompt,
          };
        }
      }
      return results;
    },
    command: async (name, args = "") => {
      const command = fake.commands.get(name);
      if (!command) throw new Error(`no command ${name}`);
      await command.handler(args, fake.ctx());
    },
    api: {
      zod: {
        object: () => schema,
        string: () => schema,
        number: () => schema,
        array: () => schema,
        enum: () => schema,
        union: () => schema,
      },
      setLabel: () => {},
      registerFlag: (name, flag) => {
        if (flag.default !== undefined && !flags.has(name)) flags.set(name, flag.default);
      },
      getFlag: (name) => flags.get(name),
      getThinkingLevel: () => options.thinking,
      registerCommand: (name, command) => void fake.commands.set(name, command),
      registerTool: (tool) => void fake.tools.set(tool.name, tool as Tool),
      on: (event: string, handler: (event: never, ctx: CatalyContext) => unknown) => {
        const list = fake.handlers.get(event) ?? [];
        list.push(handler as (event: unknown, ctx: CatalyContext) => unknown);
        fake.handlers.set(event, list);
      },
      appendEntry: (customType, data) => void fake.session.entries.push({ type: "custom", customType, data }),
      sendMessage: (message, sendOptions) => {
        fake.messages.push({ content: message.content, options: sendOptions });
        fake.sent.push({ customType: message.customType, content: message.content, options: sendOptions });
      },
      sendUserMessage: async (text) => void fake.userMessages.push(text),
      getActiveTools: () => [...fake.active],
      setActiveTools: async (names) => {
        fake.active = [...names];
      },
    },
  };
  return fake;
};

/** Points the Cataly config at a fresh state dir; returns the state dir. */
export const useConfig = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omp-cataly-ext-"));
  const stateDir = join(dir, "state");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir }));
  process.env.CATALY_CONFIG = join(dir, "config.json");
  delete process.env.CATALY_STATE_DIR;
  return stateDir;
};

export const load = async (options: FakeOptions): Promise<FakePi> => {
  const fake = fakePi(options);
  // The native preparer canonicalizes Cataly's optional host import; only the unit API is fake.
  const { nativeExtensionFactory } = await import("../../test/fixtures/omp-native-host/compose.ts");
  const factory: unknown = await nativeExtensionFactory(join(import.meta.dir, "../index.ts"));
  if (typeof factory !== "function") throw new Error("native Cataly fixture has no factory");
  await factory(fake.api);
  return fake;
};

export const until = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};

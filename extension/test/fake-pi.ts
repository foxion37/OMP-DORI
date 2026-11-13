import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ompDori from "../index";
import type { CommandOptions as Command, DoriApi, DoriContext, ToolDefinition as Tool } from "../index";

export type Entry = { type: string; customType?: string; data?: unknown; mode?: string; modeData?: Record<string, unknown> };
export type FakeSession = { id: string; file?: string; entries: Entry[] };
type Agent = DoriContext["agent"];
export type FakeOptions = { session: FakeSession; flags?: Record<string, string>; agent?: Agent; active?: string[] };

export type FakePi = {
  api: DoriApi;
  handlers: Map<string, Array<(event: unknown, ctx: DoriContext) => unknown>>;
  commands: Map<string, Command>;
  tools: Map<string, Tool>;
  active: string[];
  messages: Array<{ content: string; options: unknown }>;
  userMessages: string[];
  notes: string[];
  session: FakeSession;
  /** What ctx.model / ctx.getContextUsage() report; tests change these between turns. */
  model?: { provider?: string; id: string };
  usage?: { tokens: number; contextWindow: number; percent: number };
  ctx(): DoriContext;
  /** Runs handlers in registration order, like omp's runner; returns their results. */
  emit(event: string, payload?: unknown): Promise<unknown[]>;
  command(name: string, args?: string): Promise<void>;
};

const schema = { optional: () => schema, describe: () => schema };

export const fakePi = (options: FakeOptions): FakePi => {
  const flags = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
  const agent: Agent = options.agent ?? { kind: "main", id: "Main" };
  const fake: FakePi = {
    handlers: new Map(),
    commands: new Map(),
    tools: new Map(),
    active: options.active ?? ["read", "bash"],
    messages: [],
    userMessages: [],
    notes: [],
    session: options.session,
    ctx: () => ({
      cwd: tmpdir(),
      mode: "print",
      agent,
      ...(fake.model ? { model: fake.model } : {}),
      getContextUsage: () => fake.usage,
      sessionManager: { getSessionId: () => fake.session.id, getSessionFile: () => fake.session.file, getBranch: () => fake.session.entries },
      ui: { notify: (message: string) => void fake.notes.push(message) },
    }),
    emit: async (event, payload = { type: event }) => {
      const results: unknown[] = [];
      for (const handler of [...(fake.handlers.get(event) ?? [])]) results.push(await handler(payload, fake.ctx()));
      return results;
    },
    command: async (name, args = "") => {
      const command = fake.commands.get(name);
      if (!command) throw new Error(`no command ${name}`);
      await command.handler(args, fake.ctx());
    },
    api: {
      zod: { object: () => schema, string: () => schema, array: () => schema, enum: () => schema },
      setLabel: () => {},
      registerFlag: (name, flag) => {
        if (flag.default !== undefined && !flags.has(name)) flags.set(name, flag.default);
      },
      getFlag: (name) => flags.get(name),
      registerCommand: (name, command) => void fake.commands.set(name, command),
      registerTool: (tool) => void fake.tools.set(tool.name, tool as Tool),
      on: (event: string, handler: (event: never, ctx: DoriContext) => unknown) => {
        const list = fake.handlers.get(event) ?? [];
        list.push(handler as (event: unknown, ctx: DoriContext) => unknown);
        fake.handlers.set(event, list);
      },
      appendEntry: (customType, data) => void fake.session.entries.push({ type: "custom", customType, data }),
      sendMessage: (message, sendOptions) => void fake.messages.push({ content: message.content, options: sendOptions }),
      getActiveTools: () => [...fake.active],
      setActiveTools: async (names) => {
        fake.active = [...names];
      },
    },
  };
  // omp-ulw talks to these too; they are outside omp-dori's own API surface.
  Object.assign(fake.api, { sendUserMessage: (text: string) => void fake.userMessages.push(text), getAllTools: () => fake.active.map((name) => ({ name })) });
  return fake;
};

/** Points the Dori config at `ompUlwPath` and a fresh state dir; returns the state dir. */
export const useConfig = (ompUlwPath: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "omp-dori-ext-"));
  const stateDir = join(dir, "state");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir, ompUlwPath }));
  process.env.DORI_CONFIG = join(dir, "config.json");
  delete process.env.DORI_STATE_DIR;
  return stateDir;
};

export const load = async (options: FakeOptions): Promise<FakePi> => {
  const fake = fakePi(options);
  await ompDori(fake.api);
  return fake;
};

export const until = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};

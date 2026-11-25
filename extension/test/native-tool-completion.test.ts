import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  COMPLETION_ENTRY,
  type Completion,
  completionReceipt,
  toolEvidence,
} from "../../skills/cataly-mode/scripts/src/tool-evidence.ts";
import type * as AsyncModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/async/index";
import type * as EvalBackendModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/eval/index";
import type * as EvalModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/tools/eval";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { Registry } from "../../skills/cataly-mode/scripts/src/registry.ts";
import type { ModelRegistry } from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/model-registry";
import type * as SettingsModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/settings";
import type * as MirrorModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/lifecycle-mirror";
import type * as LoaderModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/loader";
import type * as RunnerModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/runner";
import type * as SessionModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/session-manager";
import type * as BusModule from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/utils/event-bus";
import { assertNativeHost } from "../../test/fixtures/omp-native-host/host.ts";
import { useConfig } from "./fake-pi";

type SessionEvent = Parameters<typeof MirrorModule.extensionEventFromSessionEvent>[0];

// The module path is runtime-selected: the exact native host fixture (CATALY_TEST_OMP_ROOT) whose module instances its
// extension preparer, compose.ts, uses. The types above are that fixture's declarations.
const host = async <T>(path: string): Promise<T> => {
  await assertNativeHost();
  return (await import(join(realpathSync(process.env["CATALY_TEST_OMP_ROOT"] ?? ""), "src", path))) as T;
};

const HEADLESS = "00000000-0000-4000-8000-000000000006";
const KEY = "native-evidence-lane";
beforeEach(async () => {
  const stateDir = useConfig();
  process.env.CATALY_HEADLESS_ID = HEADLESS;
  await new Registry(stateDir).write({
    key: KEY,
    title: "native evidence",
    thread: "none",
    sessionRef: { runtime: "headless", id: HEADLESS },
    brief: "/brief.md",
    done: "file /done.md",
    openedAt: "2026-01-01T00:00:00.000Z",
    reportProtocol: "jsonl-v1",
  });
});
afterEach(() => {
  delete process.env.CATALY_HEADLESS_ID;
});

/**
 * Cataly loaded as a lane by the native loader and runner on an in-memory native session in `cwd`, with no model or
 * provider.
 */
const nativeLane = async (cwd = import.meta.dir) => {
  const [
    { ExtensionRunner, emitSessionShutdownEvent },
    loader,
    mirror,
    { SessionManager },
    { Settings },
    { EventBus },
  ] = await Promise.all([
    host<typeof RunnerModule>("extensibility/extensions/runner.ts"),
    host<typeof LoaderModule>("extensibility/extensions/loader.ts"),
    host<typeof MirrorModule>("extensibility/extensions/lifecycle-mirror.ts"),
    host<typeof SessionModule>("session/session-manager.ts"),
    host<typeof SettingsModule>("config/settings.ts"),
    host<typeof BusModule>("utils/event-bus.ts"),
  ]);
  // Loaded only here, as fake-pi does: its host imports need the native fixture this test requires.
  const { nativeExtensionFactory } = await import("../../test/fixtures/omp-native-host/compose.ts");
  const runtime = new loader.ExtensionRuntime();
  runtime.flagValues.set("cataly-role", "lane");
  const session = SessionManager.inMemory(cwd);
  const factory = await nativeExtensionFactory(join(import.meta.dir, "../index.ts"));
  const cataly = await loader.loadExtensionFromFactory(factory, cwd, new EventBus(), runtime, "cataly");
  const registry = new Proxy({} as ModelRegistry, {
    get: (_target, key) => {
      throw new Error(`native evidence fixture unexpectedly accessed the model registry: ${String(key)}`);
    },
  });
  const settings = Settings.isolated({ "prewalk.auto": "off", "prewalk.enabled": false });
  const runner = new ExtensionRunner([cataly], runtime, cwd, session, registry, undefined, settings);
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  const forbidden = (): never => {
    throw new Error("native evidence fixture attempted an action outside the lane's evidence path");
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
      getModel: () => undefined,
      isIdle: () => true,
      abort: forbidden,
      hasPendingMessages: () => false,
      shutdown: forbidden,
      getContextUsage: () => undefined,
      compact: forbidden,
      getSystemPrompt: () => [],
    },
    undefined,
    // A headless lane runs in rpc mode with the supervisor's UI channel: a UI distinct from the runner's no-op one.
    Object.create(runner.getUIContext()),
    "rpc",
  );
  // Agent events reach extensions through the session's own mapping, as AgentSession#emitExtensionEvent sends them.
  const emit = async (event: SessionEvent): Promise<void> => {
    const mapped = mirror.extensionEventFromSessionEvent(event, 0);
    if (!mapped) throw new Error(`native host maps no extension event for ${event.type}`);
    await runner.emit(mapped);
  };
  await runner.emit({ type: "session_start" });
  /** The assistant message calling bash `id`, and the agent loop starting it in the session cwd. */
  const startBash = async (id: string, args: { command: string; async?: boolean }): Promise<void> => {
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: args }],
      api: "openai-completions",
      provider: "openai",
      model: "in-memory-test-fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    await emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args });
  };
  return {
    session,
    errors,
    newSession: async (): Promise<void> => {
      const previousSessionFile = session.getSessionFile();
      await runner.emit({ type: "session_before_switch", reason: "new" });
      await session.newSession();
      await runner.emit({ type: "session_switch", reason: "new", previousSessionFile });
    },
    /** A returned foreground bash call of OMP 18.20.0 that ran `command` without its own cwd and printed `text`. */
    foreground: async (id: string, command: string, text: string): Promise<void> => {
      await startBash(id, { command });
      const done = { content: [{ type: "text" as const, text }], details: { timeoutSeconds: 300, wallTimeMs: 5 } };
      await emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: done, isError: false });
      session.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "bash",
        ...done,
        isError: false,
        timestamp: Date.now(),
      });
    },
    /** The returned bash call of OMP 18.20.0 that started job `jobId` (#buildBackgroundStartResult). */
    background: async (id: string, jobId: string, beforeReturn?: () => Promise<void>): Promise<string> => {
      await startBash(id, { command: "bun test", async: true });
      await beforeReturn?.();
      const start = {
        content: [{ type: "text" as const, text: `Background job ${jobId} started` }],
        details: { async: { state: "running", jobId, type: "bash" }, timeoutSeconds: 300 },
      };
      await emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: start, isError: false });
      return session.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "bash",
        ...start,
        isError: false,
        timestamp: Date.now(),
      });
    },
    /** The job's report() frame through onUpdate: the result, its details and `details.async` (output excluded). */
    settle: (id: string, jobId: string, state: string, text: string) =>
      emit({
        type: "tool_execution_update",
        toolCallId: id,
        toolName: "bash",
        args: {},
        partialResult: {
          content: [{ type: "text", text }],
          details: {
            wallTimeNoticeEmitted: false,
            wallTimeMs: 12,
            timeoutSeconds: 300,
            async: { state, jobId, type: "bash" },
          },
        },
      }),
    report: async (toolCalls: string[]): Promise<string> => {
      const tool = runner.getRegisteredTool("cataly_report");
      if (!tool) throw new Error("cataly_report is not registered");
      const out = await runner.runScoped(() =>
        tool.definition.execute(
          "report",
          { kind: "milestone", text: "x", toolCalls },
          undefined,
          undefined,
          runner.createContext(),
        ),
      );
      return out.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    },
    receipts: () =>
      session
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "omp-cataly:tool-completion"),
    shutdown: async (): Promise<void> => {
      try {
        await emitSessionShutdownEvent(runner);
      } finally {
        settings.stopWatching();
        await settings.flush();
      }
    },
  };
};

test("through the native runner, a background job is evidence once on completion and its rerun is not new", async () => {
  const lane = await nativeLane();
  try {
    await lane.background("c1", "1");
    await lane.settle("c1", "1", "running", "partial");
    await expect(lane.report(["c1"])).rejects.toThrow("records no successful completion of its job");
    await lane.settle("c1", "1", "completed", "12 pass");
    expect(lane.receipts().map((entry) => entry.type === "custom" && entry.data)).toEqual([
      {
        call: "c1",
        job: "1",
        tool: "bash",
        cwd: import.meta.dir,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(await lane.report(["c1"])).toEndWith("1 of 1 evidence items are new; the evidence clock moved");
    await lane.background("c2", "2");
    await lane.settle("c2", "2", "completed", "12 pass");
    expect(await lane.report(["c2"])).toEndWith(
      "the same evidence was recorded before; the evidence clock did not move",
    );
    await lane.background("c3", "3");
    await lane.settle("c3", "3", "failed", "1 fail");
    await expect(lane.report(["c3"])).rejects.toThrow("records no successful completion of its job");
    expect(lane.receipts()).toHaveLength(2);
    expect(lane.errors).toEqual([]);
  } finally {
    await lane.shutdown();
  }
});

test("through the native runner, a relative CLI call is read in the session cwd it started in", async () => {
  const command = "bun src/cli.ts checkpoint native-evidence-lane --step s --result ok";
  const output = '{"checkpoint":{"step":"s"}}';
  const inSkill = await nativeLane(join(import.meta.dir, "../../skills/cataly-mode/scripts"));
  try {
    await inSkill.foreground("checkpoint", command, output);
    await expect(inSkill.report(["checkpoint"])).rejects.toThrow("coordinates");
    expect(inSkill.errors).toEqual([]);
  } finally {
    await inSkill.shutdown();
  }
  const elsewhere = await nativeLane();
  try {
    await elsewhere.foreground("checkpoint", command, output);
    expect(await elsewhere.report(["checkpoint"])).toEndWith("1 of 1 evidence items are new; the evidence clock moved");
    expect(elsewhere.errors).toEqual([]);
  } finally {
    await elsewhere.shutdown();
  }
});

test("through the native runner, a completion after a tree move or /new is not attributed", async () => {
  const lane = await nativeLane();
  try {
    const before = lane.session.getLeafId();
    const started = await lane.background("moved", "1");
    if (!before) throw new Error("native session has no leaf before the call");
    lane.session.branch(before);
    await lane.settle("moved", "1", "completed", "12 pass");
    lane.session.branch(started);
    expect(lane.receipts()).toEqual([]);
    await expect(lane.report(["moved"])).rejects.toThrow("records no successful completion of its job");

    await lane.background("late", "2");
    await lane.newSession();
    await lane.settle("late", "2", "completed", "12 pass");
    expect(lane.receipts()).toEqual([]);
    await expect(lane.report(["late"])).rejects.toThrow("has no completed result");
    expect(lane.errors).toEqual([]);
  } finally {
    await lane.shutdown();
  }
});

test.each(["completed", "failed", "cancelled"])(
  "a late %s job does not consume a reused call ID in the new session",
  async (state) => {
    const lane = await nativeLane();
    try {
      await lane.background("reused", "old-job");
      await lane.newSession();
      await lane.background("reused", "new-job");
      await lane.settle("reused", "old-job", state, "old result");
      expect(lane.receipts()).toEqual([]);
      await lane.settle("reused", "new-job", "completed", "12 pass");
      expect(await lane.report(["reused"])).toEndWith("1 of 1 evidence items are new; the evidence clock moved");
      expect(lane.receipts()).toHaveLength(1);
      expect(lane.errors).toEqual([]);
    } finally {
      await lane.shutdown();
    }
  },
);

test("the real EvalTool producer cannot attest async images but preserves foreground image evidence", async () => {
  const [{ EvalTool }, { AsyncJobManager }, { jsBackend }, { Settings }] = await Promise.all([
    host<typeof EvalModule>("tools/eval.ts"),
    host<typeof AsyncModule>("async/index.ts"),
    host<typeof EvalBackendModule>("eval/index.ts"),
    host<typeof SettingsModule>("config/settings.ts"),
  ]);
  // Valid same-sized one-pixel PNGs. Only the backend is synthetic: EvalTool's image aggregation,
  // foreground return, auto-background manager and terminal update producer are the actual pinned host.
  const images = [
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ].map((pixel) => {
    const chunk = (name: string, body: Uint8Array) => {
      const data = Buffer.concat([Buffer.from(name), body]);
      const out = Buffer.alloc(body.length + 12);
      out.writeUInt32BE(body.length, 0);
      data.copy(out, 4);
      out.writeUInt32BE(Bun.hash.crc32(data) >>> 0, body.length + 8);
      return out;
    };
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", Buffer.from("00000001000000010806000000", "hex")),
      chunk("IDAT", deflateSync(Buffer.from([0, ...pixel]))),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64");
  });
  expect(images[0]?.length).toBe(images[1]?.length);
  const foreground: string[] = [];
  const backgroundRuns: { branch: Parameters<typeof toolEvidence>[0]; id: string; receipt: Completion }[] = [];
  let sequence = 0;
  for (const background of [false, true]) {
    const settings = Settings.isolated({
      "eval.autoProvision": false,
      "eval.js": true,
      "eval.autoBackground.enabled": background,
      "eval.autoBackground.thresholdMs": 0,
    });
    const jobs = new AsyncJobManager({});
    const backend = spyOn(jsBackend, "execute");
    try {
      const tool = new EvalTool({
        cwd: import.meta.dir,
        hasUI: false,
        settings,
        asyncJobManager: jobs,
        getSessionFile: () => null,
        getSessionSpawns: () => "",
      });
      for (const data of images) {
        backend.mockImplementation(async (_code, options) => {
          options.onChunk("same");
          return {
            output: "same",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            artifactId: undefined,
            totalLines: 1,
            totalBytes: 4,
            outputLines: 1,
            outputBytes: 4,
            displayOutputs: [{ type: "image", data, mimeType: "image/png", detail: "original" }],
          };
        });
        const id = `image-${sequence++}`;
        const args = { language: "js" as const, code: "print(image)" };
        const updates: Parameters<NonNullable<Parameters<typeof tool.execute>[3]>>[0][] = [];
        const out = await tool.execute(id, args, undefined, (partial) => {
          updates.push(structuredClone(partial));
        });
        await jobs.waitForAll();
        const branch = [
          {
            type: "message",
            message: { role: "assistant", content: [{ type: "toolCall", id, name: "eval", arguments: args }] },
          },
          {
            type: "message",
            message: { role: "toolResult", toolCallId: id, toolName: "eval", ...out, isError: false },
          },
        ];
        if (!background) {
          expect(out.content.find((block) => block.type === "image")?.data).toBe(data);
          foreground.push(toolEvidence(branch, id, import.meta.dir).fingerprint);
          continue;
        }
        expect(out.details?.async?.state).toBe("running");
        const jobId = out.details?.async?.jobId;
        if (!jobId) throw new Error("native EvalTool returned no background job ID");
        const settled = updates.flatMap((partial) => {
          const receipt = completionReceipt(branch, id, "eval", partial, import.meta.dir);
          return receipt ? [{ partial, receipt }] : [];
        });
        expect(settled).toHaveLength(1);
        const end = settled[0];
        if (!end) throw new Error("native EvalTool emitted no terminal receipt frame");
        expect(end.receipt.job).toBe(jobId);
        expect(end.partial.content.filter((block) => block.type === "image")).toHaveLength(0);
        const details = end.partial.details;
        if (!details || typeof details !== "object") throw new Error("native EvalTool emitted no result details");
        expect("images" in details).toBe(false);
        backgroundRuns.push({ branch, id, receipt: end.receipt });
      }
    } finally {
      await jobs.dispose();
      backend.mockRestore();
      settings.stopWatching();
      await settings.flush();
    }
  }
  expect(foreground).toHaveLength(2);
  expect(foreground[0]).not.toBe(foreground[1]);
  expect(backgroundRuns.map(({ receipt }) => ("refused" in receipt ? receipt.refused : receipt.fingerprint))).toEqual([
    expect.stringContaining("full result"),
    expect.stringContaining("full result"),
  ]);
  for (const { branch, id, receipt } of backgroundRuns) {
    expect(() =>
      toolEvidence([...branch, { type: "custom", customType: COMPLETION_ENTRY, data: receipt }], id, import.meta.dir),
    ).toThrow("full result");
  }
});

test("an early completion is bound to the returned job, not a late job with the same call ID", async () => {
  const lane = await nativeLane();
  try {
    await lane.background("early", "old-job");
    await lane.newSession();
    await lane.background("early", "new-job", async () => {
      await lane.settle("early", "new-job", "completed", "12 pass");
      await lane.settle("early", "old-job", "cancelled", "old result");
      expect(lane.receipts()).toEqual([]);
    });
    expect(await lane.report(["early"])).toEndWith("1 of 1 evidence items are new; the evidence clock moved");
    expect(lane.receipts().map((entry) => entry.type === "custom" && entry.data)).toEqual([
      {
        call: "early",
        job: "new-job",
        tool: "bash",
        cwd: import.meta.dir,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(lane.errors).toEqual([]);
  } finally {
    await lane.shutdown();
  }
});

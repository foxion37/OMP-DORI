import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { HeadAdmissions } from "../../../extension/head-admission.ts";
import { SESSION_WIRE } from "../../../skills/cataly-mode/scripts/src/session-compat.ts";
import { SOL_MODEL } from "./compose.ts";

/** Real AgentSession, extension dispatch and file persistence; only the provider is a canned in-process stream. */
export async function nativeMessageHead(root: string, manager: SessionManager, admissions: HeadAdmissions) {
  const refuseNetwork = () => { throw new Error("native admission fixture forbids network requests"); };
  globalThis.fetch = Object.assign(async () => refuseNetwork(), { preconnect: refuseNetwork });
  const release = Promise.withResolvers<void>();
  let requests = 0;
  registerCustomApi("fixture", (model) => {
    const stream = createAssistantMessageEventStream();
    const first = ++requests === 1;
    void (async () => {
      if (first) await release.promise;
      const message = {
        role: "assistant" as const, content: [{ type: "text" as const, text: "Recorded fixture response." }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop" as const,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    })().catch((error) => stream.fail(error));
    return stream;
  }, "cataly-native-admission-fixture");
  const settings = Settings.isolated({ "prewalk.auto": "off", "prewalk.enabled": false });
  let api: ExtensionAPI | undefined;
  let nativeManager: SessionManager | undefined;
  const errors: unknown[] = [];
  const sends: Promise<unknown>[] = [];
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), sessionManager: manager, settings,
    model: { ...SOL_MODEL, id: "recorded-response", name: "Recorded response", provider: "fixture", reasoning: false },
    getApiKey: async () => "synthetic-fixture-key", disableModelFallback: true, cacheWarming: "off",
    systemPrompt: "Respond using the recorded fixture stream.", toolNames: [], preloadedCustomToolPaths: [],
    skills: [], rules: [], contextFiles: [], noContextFiles: true, promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    suppressAutoPrewalk: true, autoTitle: false, deferHintCompression: true,
    disableExtensionDiscovery: true, additionalExtensionPaths: [],
    extensions: [(extension) => {
      api = extension;
      extension.on("session_start", (_event, context) => {
        // Use the real native context object, not a hand-built SessionManager facade.
        nativeManager = context.sessionManager as SessionManager;
      });
      extension.on("message_end", async (event) => {
        const message = event.message;
        if (message.role !== "custom" || message.customType !== SESSION_WIRE.monitorMessage) return;
        const details = message.details as { ompCatalyAdmission: { identity: string; fingerprint: string } };
        const published = readFileSync(manager.getSessionFile()!, "utf8").includes(JSON.stringify(details.ompCatalyAdmission.identity));
        await admissions.messageEnded(event);
        process.send?.({ event: "native-message-end", details, published });
      });
    }],
  });
  await initializeExtensions(session, {
    reportSendError: (_action, error) => errors.push(error),
    reportRuntimeError: (error) => errors.push(error),
    trackExtensionSend: (task) => {
      sends.push(task);
      // The first turn cannot finish until message 102 has entered the live aside queue.
      if (sends.length === 2) void task.then(() => release.resolve(), (error) => release.reject(error));
    },
  });
  if (!api || !nativeManager) throw new Error("native extension did not initialize");
  const nativeApi = api;
  return {
    manager: nativeManager,
    send(content: string, details: unknown) {
      process.send?.({ event: "native-send", streaming: session.isStreaming, requests });
      nativeApi.sendMessage({ customType: SESSION_WIRE.monitorMessage, content, display: true, details }, { deliverAs: "aside", triggerTurn: true });
    },
    async close() {
      release.resolve();
      await Promise.all(sends);
      await session.dispose();
      settings.stopWatching();
      await settings.flush();
      if (errors.length) throw new AggregateError(errors, "native extension admission failed");
    },
  };
}

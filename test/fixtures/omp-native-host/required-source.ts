import assert from "node:assert/strict";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { nativeExtensionFactory } from "./compose.ts";

/** Real native runner and provider transport; no external provider or credentials. */
export async function requiredSourceRequest(
  entry: string,
  cwd: string,
  role: "lane" | "dori" | undefined,
  boundary: "session" | "provider",
): Promise<{ requests: number; errors: Array<{ event: string; error: string }> }> {
  const factory = await nativeExtensionFactory(entry);
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(
        'data: {"id":"local","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n' +
          'data: {"id":"local","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const model = {
    id: "required-source-local",
    name: "Local transport fixture",
    api: "openai-completions",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 1024,
    identity: { class: "unknown" },
    compat: undefined,
  } satisfies NonNullable<ExtensionContext["model"]>;
  const settings = Settings.isolated({
    "compaction.enabled": false,
    "async.widgets": false,
    "retry.enabled": false,
    "retry.modelFallback": false,
    "prewalk.auto": "off",
    "prewalk.enabled": false,
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let auth: AuthStorage | undefined;
  const errors: Array<{ event: string; error: string }> = [];
  try {
    auth = await AuthStorage.create(join(cwd, "empty-auth.db"));
    auth.keys.setRuntime("openai", "local-fixture-only");
    const registry = new ModelRegistry(auth, join(cwd, "models.yml"), {
      settings,
      cacheDbPath: join(cwd, "models.db"),
      fetch: async () => {
        throw new Error("Native source regression prohibits external catalog access");
      },
    });
    const manager = SessionManager.inMemory(cwd);
    if (role) manager.appendCustomEntry("omp-dori:role", role);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      agentId: `required-source-${manager.getSessionId()}`,
      sessionManager: manager,
      authStorage: auth,
      modelRegistry: registry,
      model,
      settings,
      bindProcessState: false,
      cacheWarming: false,
      disableModelFallback: true,
      toolNames: [],
      disableExtensionDiscovery: true,
      extensions: [factory],
      skills: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      getApiKey: async (selected) => {
        assert.equal(selected.baseUrl, model.baseUrl);
        return "local-fixture-only";
      },
      assertDispatchModel: (selected) => assert.equal(selected.baseUrl, model.baseUrl),
    }));
    assert(session.extensionRunner);
    await initializeExtensions(session, {
      mode: "json",
      reportRuntimeError: (error) => errors.push({ event: error.event, error: error.error }),
      reportSendError: (_action, error) => {
        throw error;
      },
    });
    if (boundary === "session") await session.prompt("Return OK.");
    else await session.agent.prompt({ role: "user", content: "Return OK.", timestamp: Date.now() });
    return { requests, errors };
  } finally {
    await session?.dispose();
    auth?.close();
    settings.stopWatching();
    await settings.flush();
    server.stop(true);
  }
}

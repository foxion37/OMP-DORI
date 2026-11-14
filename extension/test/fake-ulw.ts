/** Stand-in for omp-ulw's `ompUlw(pi)`: one of each runtime entry point, recording what actually ran. */
import type { DoriApi, DoriContext } from "../index";

export const calls: string[] = [];

type UlwApi = DoriApi & { sendUserMessage(text: string): void };

export default function fakeUlw(pi: UlwApi): void {
  pi.registerFlag("fake-ulw-disabled", { type: "boolean", default: false });
  pi.registerCommand("ulw", {
    description: "fake ulw",
    handler: async (args) => {
      calls.push("command");
      pi.sendUserMessage(`ulw ${args}`);
    },
  });
  pi.registerTool({
    name: "fake_ulw_tool",
    label: "fake",
    description: "fake",
    parameters: {},
    execute: async () => {
      calls.push("tool");
      return { content: [{ type: "text", text: "ran" }] };
    },
  });
  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
    pi.on(event, (_event: unknown, ctx: DoriContext) => {
      calls.push(`restore:${ctx.sessionManager.getSessionId()}`);
    });
  }
  pi.on("before_agent_start", (event: unknown) => {
    calls.push("before_agent_start");
    const prompt =
      event && typeof event === "object" && "systemPrompt" in event && Array.isArray(event.systemPrompt)
        ? event.systemPrompt
        : [];
    return { systemPrompt: [...prompt, "<fake-ulw-policy>"] };
  });
}

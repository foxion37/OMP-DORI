import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import installReviewerGuard, {
  enforceReviewTools,
  readReviewScope,
  type ReviewScope,
} from "../src/update/reviewer-guard.ts";
import installWorkerGuard, { enforceWorkerTools, readWorkerScope } from "../src/update/worker-guard.ts";
import { fixture } from "./update-setup.ts";

describe("enforced native reviewer scope", () => {
  test("runtime selection replaces implicit write/MCP capabilities and checks the exact read-only set", async () => {
    let active = ["read", "write", "mcp__fixture_write"];
    const observed = await enforceReviewTools({
      getActiveTools: () => [...active],
      setActiveTools: async (names) => {
        active = [...names];
      },
    });
    expect(observed.toSorted()).toEqual(["glob", "grep", "read"]);
    await expect(
      enforceReviewTools({
        getActiveTools: () => ["read", "grep", "glob", "write"],
        setActiveTools: async () => {},
      }),
    ).rejects.toThrow("not restricted");
    await expect(
      enforceReviewTools({
        getActiveTools: () => ["read", "grep", "glob", "mcp__fixture_write"],
        setActiveTools: async () => {},
      }),
    ).rejects.toThrow("not restricted");
  });

  test("worker keeps built-in editing tools, drops MCP/subagent/web tools, and denies late widening without failing the port", async () => {
    const f = fixture();
    const path = join(f.directory, "worker-scope.json");
    const values = {
      DORI_UPDATE_WORKER_SCOPE: path,
      DORI_UPDATE_WORKER_NONCE: "worker-nonce",
      DORI_UPDATE_WORKER_JOB: "a".repeat(64),
    };
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    type Context = { sessionManager: { getSessionId(): string } };
    const handlers: Record<string, (event: unknown, ctx: Context) => unknown> = {};
    const everything = [
      "read",
      "grep",
      "glob",
      "find",
      "edit",
      "write",
      "bash",
      "task",
      "web_search",
      "mcp__owner_tool",
    ];
    let active = [...everything];
    try {
      Object.assign(process.env, values);
      installWorkerGuard({
        getActiveTools: () => [...active],
        getAllTools: () => everything.map((name) => ({ name })),
        setActiveTools: async (names) => {
          active = [...names];
        },
        on: (name, handler) => {
          handlers[name] = handler;
        },
      });
      const ctx = { sessionManager: { getSessionId: () => "fresh-worker" } };
      await handlers["before_agent_start"]!({}, ctx);
      await handlers["before_provider_request"]!({}, ctx);
      expect(active.toSorted()).toEqual(["bash", "edit", "find", "glob", "grep", "read", "write"]);
      expect(handlers["tool_call"]!({ toolName: "edit" }, ctx)).toBeUndefined();
      expect(handlers["tool_call"]!({ toolName: "mcp__owner_tool" }, ctx)).toMatchObject({ block: true });
      expect(handlers["tool_call"]!({ toolName: "task" }, ctx)).toMatchObject({ block: true });
      const expected = { nonce: "worker-nonce", job: values.DORI_UPDATE_WORKER_JOB, pid: process.pid };
      const scope = readWorkerScope(path, expected);
      expect(scope.blocked.toSorted()).toEqual(["mcp__owner_tool", "task"]);
      expect(() => readWorkerScope(path, { ...expected, nonce: "old" })).toThrow("matching runtime tool-scope");
      await expect(
        enforceWorkerTools({
          getActiveTools: () => ["read", "edit", "write", "bash", "mcp__owner_tool"],
          setActiveTools: async () => {},
        }),
      ).rejects.toThrow("not restricted");
      await expect(
        enforceWorkerTools({
          getActiveTools: () => ["read"],
          getAllTools: () => [{ name: "read" }],
          setActiveTools: async () => {},
        }),
      ).rejects.toThrow("required built-in");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("late MCP registration is blocked before execution and remains visible after another provider guard", async () => {
    const f = fixture();
    const path = join(f.directory, "late-review-scope.json");
    const values = {
      DORI_UPDATE_REVIEW_SCOPE: path,
      DORI_UPDATE_REVIEW_NONCE: "late-review",
      DORI_UPDATE_REVIEW_JOB: "a".repeat(64),
      DORI_UPDATE_REVIEW_SOURCE: "b".repeat(64),
    };
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    type Context = { sessionManager: { getSessionId(): string } };
    const handlers: Record<string, (event: unknown, ctx: Context) => unknown> = {};
    let active = ["read", "write", "mcp__fixture_write"];
    try {
      Object.assign(process.env, values);
      installReviewerGuard({
        getActiveTools: () => [...active],
        setActiveTools: async (names) => {
          active = [...names];
        },
        on: (name, handler) => {
          handlers[name] = handler;
        },
      });
      const ctx = { sessionManager: { getSessionId: () => "fresh-native-review" } };
      await handlers["before_agent_start"]!({}, ctx);
      await handlers["before_provider_request"]!({}, ctx);
      const expected = {
        nonce: values.DORI_UPDATE_REVIEW_NONCE,
        job: values.DORI_UPDATE_REVIEW_JOB,
        sourceHash: values.DORI_UPDATE_REVIEW_SOURCE,
        pid: process.pid,
      };
      expect(readReviewScope(path, expected).active.toSorted()).toEqual(["glob", "grep", "read"]);
      active.push("mcp__fixture_write");
      expect(handlers["tool_call"]!({ toolName: "mcp__fixture_write" }, ctx)).toMatchObject({ block: true });
      expect(handlers["tool_call"]!({ toolName: "write" }, ctx)).toMatchObject({ block: true });
      await handlers["before_provider_request"]!({}, ctx);
      expect(JSON.parse(readFileSync(path, "utf8")).blocked).toContain("mcp__fixture_write");
      expect(() => readReviewScope(path, expected)).toThrow("matching, source-bound");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("scope evidence must bind this child, source and nonce and include pre-request enforcement", () => {
    const f = fixture();
    const path = join(f.directory, "review-scope.json");
    const expected = { nonce: "current-review", job: "a".repeat(64), sourceHash: "b".repeat(64), pid: process.pid };
    const scope: ReviewScope = {
      version: 1,
      ...expected,
      active: ["read", "grep", "glob"],
      callBlocker: true,
      blocked: [],
      stages: ["before_agent_start", "before_provider_request"],
      sessionId: "new-review-session",
      at: new Date().toISOString(),
    };
    const store = (value: unknown) => writeFileSync(path, JSON.stringify(value));
    store(scope);
    expect(readReviewScope(path, expected).sessionId).toBe("new-review-session");
    for (const patch of [
      { nonce: "old-review" },
      { sourceHash: "c".repeat(64) },
      { pid: process.pid + 1 },
      { active: ["read", "grep", "glob", "write"] },
      { stages: ["before_agent_start"] },
      { callBlocker: false },
      { blocked: ["mcp__fixture_write"] },
    ]) {
      store({ ...scope, ...patch });
      expect(() => readReviewScope(path, expected)).toThrow("matching, source-bound");
    }
    writeFileSync(path, "{");
    expect(() => readReviewScope(path, expected)).toThrow();
  });
});

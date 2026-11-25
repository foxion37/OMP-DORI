import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { COMPLETION_ENTRY, completionReceipt, toolEvidence } from "../src/tool-evidence.ts";

// The session cwd the eval call started in: a work directory, and the skill's scripts directory.
const CWD = "/work/app";
const SCRIPTS = join(import.meta.dir, "..");

// Public EvalToolDetails / EvalCellResult frames produced by the pinned native host.
const cell = (extra: Record<string, unknown> = {}) => ({
  index: 0,
  language: "js",
  code: "print('same')",
  title: "Run",
  status: "complete",
  exitCode: 0,
  output: "same",
  durationMs: 1,
  ...extra,
});
const call = (id: string, code = "await work()") => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "eval", arguments: { code } }],
  },
});
const result = (id: string, cells: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "eval",
    content: [{ type: "text", text: "same" }],
    isError: false,
    details: { cells, ...extra },
  },
});

describe("native eval evidence", () => {
  test("native cell timing and input labels are not new output", () => {
    const branch = [
      call("first"),
      result("first", [cell()]),
      call("rerun"),
      result("rerun", [
        cell({
          durationMs: 9_000,
          title: "Run again",
          code: "print('same'); // same output",
        }),
      ]),
    ];
    expect(toolEvidence(branch, "rerun", CWD).fingerprint).toBe(toolEvidence(branch, "first", CWD).fingerprint);
  });

  test("timing-named fields in actual result data remain evidence", () => {
    const branch = [
      call("first"),
      result("first", [cell({ views: [{ durationMs: 1 }] })]),
      call("changed"),
      result("changed", [cell({ views: [{ durationMs: 2 }] })]),
    ];
    expect(toolEvidence(branch, "changed", CWD).fingerprint).not.toBe(toolEvidence(branch, "first", CWD).fingerprint);
  });

  test("a successful eval shell operation still lacks its effective execution directory", () => {
    const cells = [cell({ statusEvents: [{ op: "run", cmd: "printf same", code: 0, output: "same" }] })];
    expect(() => toolEvidence([call("shell"), result("shell", cells)], "shell", CWD)).toThrow("execution directory");
  });

  test.each([
    [
      "a nested background start without an exit code",
      { statusEvents: [{ op: "run", cmd: "sleep 30; echo done", output: "Backgrounded as job bg_1" }] },
    ],
    ["a caught nested failure", { statusEvents: [{ op: "run", cmd: "false", code: 1, output: "" }] }],
    ["a caught tool error", { statusEvents: [{ op: "read", path: "missing", hasError: true, error: "ENOENT" }] }],
    ["an opaque child job", { statusEvents: [{ op: "task", chars: 20 }] }],
    ["elided operations", { statusEvents: [], statusEventsElided: 1 }],
    ["a cell that is not complete", { status: "running" }],
  ])("refuses %s even when the outer eval returns successfully", (_why, extra) => {
    expect(() => toolEvidence([call("eval"), result("eval", [cell(extra)])], "eval", CWD)).toThrow("completion");
  });

  test("a command name inside an eval string is data, not an executed operation", () => {
    const code = 'const guide = "cataly report lane"; print("same")';
    const branch = [call("literal", code), result("literal", [cell({ code })])];
    expect(toolEvidence(branch, "literal", CWD).kind).toBe("tool");
  });

  test("an env-wrapped coordination command is recognized in the executed operation", () => {
    const cells = [
      cell({ statusEvents: [{ op: "run", cmd: "env cataly checkpoint lane", code: 0, output: '{"checkpoint":{}}' }] }),
    ];
    expect(() => toolEvidence([call("wrapped"), result("wrapped", cells)], "wrapped", CWD)).toThrow("coordinates");
  });

  test("a variable holding a coordination command cannot hide behind the eval result", () => {
    const cells = [
      cell({
        statusEvents: [
          { op: "run", cmd: "cataly report lane --kind milestone --text hi", code: 0, output: "accepted" },
        ],
      }),
    ];
    expect(() => toolEvidence([call("eval"), result("eval", cells)], "eval", CWD)).toThrow("coordinates");
  });

  test("eval run events cannot attest a default or overridden cwd, while literal output needs none", () => {
    const checkpoint = "bun src/cli.ts checkpoint lane --step s --result ok";
    const code = `await sh(${JSON.stringify(checkpoint)}, { cwd: ${JSON.stringify(SCRIPTS)} })`;
    const run = (cmd: string) => [
      call("eval", code),
      result("eval", [cell({ code, statusEvents: [{ op: "run", cmd, code: 0, output: '{"checkpoint":{}}' }] })]),
    ];
    for (const cwd of [CWD, SCRIPTS, undefined])
      expect(() => toolEvidence(run(checkpoint), "eval", cwd)).toThrow("execution directory");
    expect(() => toolEvidence(run(`printf '%s' '${checkpoint}'`), "eval", SCRIPTS)).toThrow("execution directory");
    // Without command operations, the same words remain literal data, not guessed execution.
    const literal = `const guide = ${JSON.stringify(checkpoint)}; print("same")`;
    expect(
      toolEvidence([call("plain", literal), result("plain", [cell({ code: literal })])], "plain", undefined).kind,
    ).toBe("tool");
  });

  test("an outer async eval completion does not attest nested work", () => {
    const branch = [call("eval"), result("eval", [], { async: { state: "running", jobId: "eval-job" } })];
    const frame = {
      content: [{ type: "text", text: "same" }],
      details: {
        async: { state: "completed", jobId: "eval-job" },
        cells: [cell({ statusEvents: [{ op: "run", cmd: "sleep 30", output: "Backgrounded as job child-job" }] })],
      },
    };
    const receipt = completionReceipt(branch, "eval", "eval", frame, CWD);
    expect(structuredClone(receipt)).toMatchObject({
      call: "eval",
      job: "eval-job",
      tool: "eval",
      cwd: CWD,
      refused: expect.stringContaining("completion"),
    });
    expect(() =>
      toolEvidence([...branch, { type: "custom", customType: COMPLETION_ENTRY, data: receipt }], "eval", CWD),
    ).toThrow("completion");
  });

  test("apparently complete async eval text cannot attest the full result", () => {
    const branch = [
      call("eval"),
      result("eval", [cell({ status: "running" })], {
        async: { state: "running", jobId: "eval-job" },
      }),
    ];
    const frame = {
      content: [{ type: "text", text: "same" }],
      details: { async: { state: "completed", jobId: "eval-job" }, cells: [cell()] },
    };
    const receipt = completionReceipt(branch, "eval", "eval", frame, CWD);
    expect(structuredClone(receipt)).toMatchObject({ refused: expect.stringContaining("full result") });
    expect(() =>
      toolEvidence([...branch, { type: "custom", customType: COMPLETION_ENTRY, data: receipt }], "eval", CWD),
    ).toThrow("full result");
  });
});

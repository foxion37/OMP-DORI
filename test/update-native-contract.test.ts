import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateInterrupted } from "../src/update/config.ts";
import { loadUpdateConfig } from "../src/update/load.ts";
import { nativePromptOptions } from "../src/update/native-prompts.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const MODEL = "anthropic/claude-opus-5-5";
const ROLES = ["worker", "reviewer"] as const;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dori-native-contract-"));
  directories.push(directory);
  const ancestor = join(directory, "untrusted-parent");
  const candidate = join(ancestor, "candidate");
  const runtime = join(directory, "controller-runtime");
  const remote = join(directory, "remote");
  const modelAgentDir = join(directory, "trusted-model-client");
  for (const path of [candidate, runtime, remote, modelAgentDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const auth = join(modelAgentDir, "auth.json");
  writeFileSync(auth, '{"contract":"trusted reference; never copied"}\n', { mode: 0o600 });
  const agent = (name: string) => ({ name, argv: ["omp", "--model", MODEL, "-p", "{prompt}"], timeoutMs: 1000 });
  const config = {
    version: 1,
    target: "dori",
    runtime: "herdr",
    root: join(directory, "updates"),
    remote,
    ref: "refs/heads/main",
    baseUpstream: "a".repeat(40),
    localSource: candidate,
    worker: agent("port"),
    reviewer: agent("review"),
    provision: [],
    checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    modelAgentDir,
  };
  const path = join(directory, "update.json");
  const load = (argv: readonly string[], role: "worker" | "reviewer" = "worker", engine?: "omp" | "external") => {
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        [role]: { ...config[role], argv, ...(engine === undefined ? {} : { engine }) },
      }),
    );
    return loadUpdateConfig(path);
  };
  return { directory, ancestor, candidate, runtime, auth, modelAgentDir, load };
}

describe("native staged-update authority", () => {
  test("real candidate and ancestor system/template files never become prompt argv or auth state", () => {
    const f = fixture();
    const argv = ["omp", "--model", MODEL, "-p", "Complete the controller task."];
    const worker = nativePromptOptions(f.runtime, f.candidate, "worker", argv);
    const review = nativePromptOptions(f.runtime, f.candidate, "review", argv);
    const auth = readFileSync(f.auth, "utf8");
    const marker = "UNTRUSTED_SYSTEM_AUTHORITY_8b7931";
    for (const root of [f.directory, f.ancestor, f.candidate]) {
      for (const name of [".omp", ".pi", ".claude", ".codex", ".gemini", ".agent", ".agents"]) {
        const base = join(root, name);
        mkdirSync(base, { recursive: true });
        for (const filename of ["SYSTEM.md", "APPEND_SYSTEM.md", "SYSTEM_TEMPLATE.md"]) {
          writeFileSync(join(base, filename), `${marker}\n{{customPrompt}}\n{{appendPrompt}}\n`);
        }
      }
    }
    for (const [kind, expected] of [
      ["worker", worker],
      ["review", review],
    ] as const) {
      const options = nativePromptOptions(f.runtime, f.candidate, kind, argv);
      expect(options).toEqual(expected);
      expect(Object.isFrozen(options)).toBe(true);
      expect(options).toHaveLength(4);
      expect(options[0]).toBe("--system-prompt");
      expect(options[2]).toBe("--append-system-prompt");
      for (const literal of [options[1]!, options[3]!]) {
        expect(literal.trim().length).toBeGreaterThan(0);
        expect(literal).toContain("\n"); // Native resolvePromptInput treats multiline values as literal text.
        expect(literal).not.toContain(marker);
        expect(literal).not.toContain(f.candidate);
        expect(literal).not.toContain(f.ancestor);
      }
    }
    expect(worker[1]).not.toBe(review[1]);
    expect(readFileSync(join(f.candidate, ".omp/SYSTEM.md"), "utf8")).toContain(marker);
    expect(readFileSync(f.auth, "utf8")).toBe(auth);
    expect(readdirSync(f.runtime)).toEqual([]);
  });

  test("linked prompt roots stay data and linked controller runtime inside the candidate is held", () => {
    const f = fixture();
    const poison = join(f.ancestor, "poison-prompts");
    mkdirSync(poison);
    writeFileSync(join(poison, "SYSTEM.md"), "LINKED_SYSTEM_POISON\n");
    writeFileSync(join(poison, "APPEND_SYSTEM.md"), "LINKED_APPEND_POISON\n");
    writeFileSync(join(poison, "SYSTEM_TEMPLATE.md"), "LINKED_TEMPLATE_POISON\n");
    symlinkSync(poison, join(f.candidate, ".omp"), "dir");
    const argv = ["omp", "--model", MODEL, "{prompt}"];
    for (const role of ["worker", "review"] as const) {
      const options = nativePromptOptions(f.runtime, f.candidate, role, argv);
      expect(options.join("\n")).not.toContain("POISON");
    }
    const inside = join(f.candidate, "runtime");
    mkdirSync(inside);
    const alias = join(f.directory, "runtime-alias");
    symlinkSync(inside, alias, "dir");
    expect(() => nativePromptOptions(alias, f.candidate, "worker", argv)).toThrow(UpdateInterrupted);
    expect(() => nativePromptOptions(f.directory, f.candidate, "review", argv)).toThrow(UpdateInterrupted);
  });

  test("controller-owned options are rejected while loading either native role", () => {
    const f = fixture();
    for (const role of ROLES) {
      const kind = role === "reviewer" ? "review" : "worker";
      for (const flag of [
        "--system-prompt",
        "--append-system-prompt",
        "--system-prompt-template",
        "--profile",
        "--alias",
        "-e",
        "--extension",
        "--extensions",
        "--trusted-extension",
        "--hook",
        "--dori-role",
      ]) {
        for (const options of [[flag, "attacker"], [`${flag}=attacker`]]) {
          const argv = ["omp", "--model", MODEL, ...options, "{prompt}"];
          expect(() => f.load(argv, role)).toThrow();
          expect(() => nativePromptOptions(f.runtime, f.candidate, kind, argv)).toThrow("owns its");
        }
      }
    }
    expect(readdirSync(f.directory)).not.toContain("updates");
  });

  test("a final positional separator protects literal flag and @file task text", () => {
    const f = fixture();
    for (const prompt of ["--system-prompt=task text", "--profile=task text", "@SYSTEM.md", "--"]) {
      const argv = ["omp", "--model", MODEL, "--", prompt];
      const before = [...argv];
      expect(nativePromptOptions(f.runtime, f.candidate, "review", argv)).toHaveLength(4);
      expect(argv).toEqual(before);
      expect(() => nativePromptOptions(f.runtime, f.candidate, "review", ["omp", "--model", MODEL, prompt])).toThrow(
        "final prompt positional",
      );
    }
    expect(() =>
      nativePromptOptions(f.runtime, f.candidate, "worker", ["omp", "--", "--model", MODEL, "{prompt}"]),
    ).toThrow("only immediately before");
    expect(() => nativePromptOptions(f.runtime, f.candidate, "review", ["omp", "--", "--", "{prompt}"])).toThrow(
      "only immediately before",
    );
  });
});

describe("native staged-update model admission", () => {
  test("both roles accept one separate or inline qualified model with a real prompt boundary", () => {
    const f = fixture();
    for (const role of ROLES) {
      for (const argv of [
        ["omp", "--model", MODEL, "--thinking", "high", "-p", "{prompt}"],
        ["omp", "--model=" + MODEL, "--mode=json", "--", "{prompt}"],
        ["omp", "--mode", "json", "--model", MODEL, "{prompt}"],
        ["omp", "--mode=json", "--model=" + MODEL, "--mode", "json", "--", "{prompt}"],
        ["/opt/native-client", "--model", MODEL, "--tools=read,grep", "{prompt}"],
      ]) {
        expect(f.load(argv, role, "omp")[role].argv).toEqual(argv);
      }
    }
  });

  const invalid: [string, string[]][] = [
    ["missing model", []],
    ["bare alias", ["--model", "opus"]],
    ["legacy role alias", ["--model=pi/default"]],
    ["missing separate value", ["--model"]],
    ["empty inline value", ["--model="]],
    ["empty model id", ["--model=anthropic/"]],
    ["empty provider", ["--model=/claude-opus-5-5"]],
    ["model pattern", ["--model=anthropic/*"]],
    ["variable model", ["--model={model}"]],
    ["prompt consumed as model", ["--model={prompt}"]],
    ["duplicate separate model", ["--model", MODEL, "--model", MODEL]],
    ["duplicate mixed model", ["--model=" + MODEL, "--model", MODEL]],
    ["separate provider", ["--provider", "anthropic", "--model", MODEL]],
    ["inline provider", ["--provider=anthropic", "--model=" + MODEL]],
    ["separate model scope", ["--models", MODEL, "--model", MODEL]],
    ["inline model scope", ["--models=" + MODEL, "--model=" + MODEL]],
    ["model after positional separator", ["--", "--model=" + MODEL]],
    ["separate model swallowed by another flag", ["--smol", "--model", MODEL]],
    ["inline model swallowed by another flag", ["--smol", "--model=" + MODEL]],
    ["dangling value flag before task", ["--model", MODEL, "--thinking"]],
    ["separator consumed as a value", ["--model", MODEL, "--thinking", "--"]],
    ["profile consumes the model flag", ["--profile", "--model", MODEL]],
    ["alias consumes the model flag", ["--alias", "--model", MODEL]],
    ["separate non-json mode", ["--model", MODEL, "--mode", "text"]],
    ["inline non-json mode", ["--model", MODEL, "--mode=rpc"]],
    ["separate mode conflict after json", ["--model", MODEL, "--mode", "json", "--mode", "text"]],
    ["separate mode conflict before json", ["--model", MODEL, "--mode", "text", "--mode", "json"]],
    ["inline mode conflict after json", ["--model", MODEL, "--mode=json", "--mode=text"]],
    ["inline mode conflict before json", ["--model", MODEL, "--mode=text", "--mode=json"]],
    ["mixed mode conflict after json", ["--model", MODEL, "--mode", "json", "--mode=text"]],
    ["mixed mode conflict before json", ["--model", MODEL, "--mode=text", "--mode", "json"]],
  ];
  test.each(invalid)("rejects %s for both native roles", (_name, options) => {
    const f = fixture();
    for (const role of ROLES) {
      expect(() => f.load(["omp", ...options, "{prompt}"], role)).toThrow();
    }
  });

  test("an explicitly external wrapper keeps its own model, prompt and fresh-context contract", () => {
    const f = fixture();
    const argv = [
      "omp",
      "--resume",
      "session",
      "--provider",
      "anthropic",
      "--models",
      "opus",
      "--system-prompt=wrapper",
      "--profile=wrapper",
      "--alias=wrapper",
      "--mode=text",
      "--mode=json",
      "{brief}",
    ];
    for (const role of ROLES) {
      const agent = f.load(argv, role, "external")[role];
      expect(agent.engine).toBe("external");
      expect(agent.argv).toEqual(argv);
    }
  });
});

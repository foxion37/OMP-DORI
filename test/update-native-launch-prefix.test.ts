import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpdateConfig, nativeAgent } from "../src/update/load.ts";
import { runCommand } from "../src/update/process.ts";
import type { UpdateJob } from "../src/update/types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// This transport fixture loads the controller's actual guard and emits protocol evidence without a model/provider.
// It proves the full receipt path, not a paid model run or native OMP CLI compatibility.
async function scopeLaunch(prefix: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "dori-native-prefix-"));
  directories.push(dir);
  for (const name of ["candidate", "remote", "bin"]) mkdirSync(join(dir, name));
  const omp = join(dir, "bin", "omp");
  writeFileSync(
    omp,
    `
const argv = process.argv.slice(2);
for (const arg of argv) console.log("ARG=" + arg);
const at = argv.indexOf("-e");
if (at < 0) throw new Error("controller did not supply its guard");
// The controller selects the worker/reviewer module through runtime -e; exercise that loading boundary.
const install = (await import(argv[at + 1])).default;
let active = ["mcp__fixture_tool"];
const handlers = new Map();
install({
  getActiveTools: () => [...active],
  getAllTools: () => ["read", "grep", "glob", "edit", "write", "bash", "mcp__fixture_tool"].map(name => ({ name })),
  setActiveTools: async names => { active = [...names]; },
  on: (name, handler) => handlers.set(name, handler),
});
const ctx = { sessionManager: { getSessionId: () => "provider-free-scope-fixture" } };
await handlers.get("before_agent_start")({}, ctx);
await handlers.get("before_provider_request")({}, ctx);
const message = {
  role: "assistant", stopReason: "stop", provider: "fixture", model: "no-provider",
  content: [{ type: "text", text: "provider-free scope fixture" }],
};
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "agent_end", isTerminal: true, messages: [message] }));
`,
  );
  const model = "--model=fixture/no-provider";
  const argv = [...prefix, process.execPath, omp, model, "{prompt}"];
  const agent = { argv, timeoutMs: 5000 };
  const path = join(dir, "update.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      target: "dori",
      runtime: "herdr",
      root: join(dir, "updates"),
      remote: join(dir, "remote"),
      ref: "refs/heads/main",
      baseUpstream: "a".repeat(40),
      localSource: join(dir, "candidate"),
      worker: { ...agent, name: "worker" },
      reviewer: { ...agent, name: "reviewer" },
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    }),
  );
  const config = loadUpdateConfig(path);
  const at = new Date().toISOString();
  const directory = mkdtempSync(join(dir, "job-"));
  const job: UpdateJob = {
    version: 1,
    id: "a".repeat(64),
    upstream: config.baseUpstream,
    baseUpstream: config.baseUpstream,
    configHash: "b".repeat(64),
    createdAt: at,
    updatedAt: at,
    phase: "verifying",
    candidate: join(dir, "candidate"),
    directory,
    sourceHash: "c".repeat(64),
    commands: [],
    history: [],
  };
  try {
    for (const role of ["worker", "reviewer"] as const) {
      const command = config[role];
      expect(nativeAgent(command)).toBe(true);
      const result = await runCommand(
        { config, configHash: job.configHash, emit: () => {} },
        job,
        command,
        { prompt: "probe" },
        "model",
      );
      expect(result.stdout).toBe("provider-free scope fixture");
      expect(result.receipt.exitCode).toBe(0);
      const pid = result.receipt.pid;
      if (pid === undefined) throw new Error("native scope fixture must record its spawned PID");
      expect(pid).toBeGreaterThan(0);
      expect(result.receipt.model).toMatchObject({
        requested: "fixture/no-provider",
        observed: "fixture/no-provider",
      });
      const scope = role === "worker" ? result.receipt.workerScope : result.receipt.reviewScope;
      const scopePath = role === "worker" ? result.receipt.workerScopePath : result.receipt.reviewScopePath;
      expect(scope).toBeDefined();
      expect(scope!.pid).toBe(pid);
      expect(scope!.job).toBe(job.id);
      expect(scope!.nonce).not.toBe("");
      expect(scope!.stages.toSorted()).toEqual(["before_agent_start", "before_provider_request"]);
      expect(scope!.callBlocker).toBe(true);
      expect(scope!.blocked).toEqual([]);
      expect(scope!.active.toSorted()).toEqual(
        role === "worker" ? ["bash", "edit", "glob", "grep", "read", "write"] : ["glob", "grep", "read"],
      );
      expect(JSON.parse(readFileSync(scopePath!, "utf8"))).toEqual(scope);
      if (role === "reviewer") expect(result.receipt.reviewScope!.sourceHash).toBe("c".repeat(64));
      const stored = JSON.parse(readFileSync(join(directory, "job.json"), "utf8")) as UpdateJob;
      expect(stored.commands.at(-1)).toEqual(result.receipt);
      const stdout = readFileSync(result.receipt.stdout, "utf8");
      expect(stdout).toContain("ARG=--no-extensions");
      expect(stdout).toContain("ARG=--system-prompt");
      expect(stdout).toContain("ARG=--no-session");
      expect(stdout).toContain("ARG=--config");
      expect(command.argv).toEqual(argv);
    }
  } finally {
    for (const ordinal of ["000", "001"]) {
      const ownership = join(directory, "runtime", ordinal, "runtime-paths.json");
      if (existsSync(ownership)) unlinkSync(JSON.parse(readFileSync(ownership, "utf8")).alias);
    }
  }
}

// POSIX-only: the launch prefix is the POSIX `env -u` utility and the scope fixture runs a shebang script.
const it = test.skipIf(process.platform === "win32");

it("env -u keeps the exact native worker and reviewer PID-bound scope receipts without a provider", async () => {
  await scopeLaunch(["env", "-u", "FOO"]);
});

// GNU stdbuf is a Linux tool (macOS has none), so retain the existing platform condition for this real wrapper.
const stdbuf = ["/usr/bin/stdbuf", "/bin/stdbuf"].find((path) => existsSync(path));
test.skipIf(stdbuf === undefined)(
  "stdbuf with a separate -e value completes both native scope receipts without a provider",
  async () => {
    await scopeLaunch([stdbuf!, "-e", "L"]);
  },
);

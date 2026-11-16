import { readFileSync, utimesSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { runtimeBinary } from "../src/update/deployment-config.ts";
import { digest } from "../src/update/source.ts";
import { managedBashFixture } from "./update-deploy-managed-setup.ts";

/** Reuse the managed Bash actor; real replacement children publish their own process-bound health. */
export async function nativeUiConsumerFixture(outcome: "delayed" | "late" | "undelivered") {
  const f = await managedBashFixture();
  const config = {
    ...f.config,
    nativeStopMode: "ui" as const,
    // These consumers test durable holds and resume, not a 100 ms subprocess-observer speed limit.
    stopTimeoutMs: outcome === "delayed" ? 2_000 : 1_000,
    healthTimeoutMs: 2_000,
  };
  const healthPath = join(config.stateDir, "runtime", `${encodeURIComponent(config.pane)}.json`);
  const modules = {
    state: new URL("../skills/dori-mode/scripts/src/lane-state.ts", import.meta.url).href,
    process: new URL("../src/update/deployment-process.ts", import.meta.url).href,
    source: new URL("../src/update/source.ts", import.meta.url).href,
  };
  const imports = `import { readFileSync as readHealth, writeFileSync as writeHealth, realpathSync } from "node:fs";
import { writePaneState } from ${JSON.stringify(modules.state)};
import { processIdentity } from ${JSON.stringify(modules.process)};
import { digest } from ${JSON.stringify(modules.source)};
`;
  const healthWriter = `const startedAt = new Date().toISOString();
const health = JSON.parse(readHealth(${JSON.stringify(healthPath)}, "utf8"));
const source = realpathSync(${JSON.stringify(config.liveSource)});
writeHealth(${JSON.stringify(healthPath)}, JSON.stringify({ ...health,
  pid: process.pid, startedAt, updatedAt: startedAt, source,
  extensionHash: digest(readHealth(source + "/extension/index.ts")),
  monitors: health.monitors.map((monitor, index) => ({ ...monitor,
    pid: children[index].pid, startTicks: processIdentity(children[index].pid).startTicks,
  })),
}));
writeHealth(${JSON.stringify(f.bootstrap.intake.path)}, String(Date.now()), { mode: 0o600 });
writePaneState(${JSON.stringify(config.stateDir)}, { ...processIdentity(process.pid),
  paneId: ${JSON.stringify(config.pane)}, role: "dori", sessionId: ${JSON.stringify(config.sessionId)},
  sessionFile: ${JSON.stringify(f.runtime.sessionFile)}, cwd: ${JSON.stringify(f.runtime.cwd)},
  startedAt, updatedAt: startedAt, approvalPending: false, agentStatus: "idle", goal: { status: "none" },
});
`;
  const ready = "console.log(JSON.stringify({ pid: process.pid, monitors: children.map(child => child.pid) }));";
  const native = readFileSync(config.omp, "utf8")
    .replace("\n", `\n${imports}`)
    .replace('const input = createReadStream("", { fd: 3 });', "const input = process.stdin;")
    .replace(ready, healthWriter + ready);
  writeFileSync(config.omp, native);
  f.record.toolchain = { ...f.record.toolchain!, ompEntryHash: digest(native) };
  f.record.oldToolchain = f.record.toolchain;
  const requests = join(f.root, "ui-consumer-requests");
  writeFileSync(requests, "");
  let handled = 0;
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(requests, () => {
    const text = readFileSync(requests, "utf8").trimEnd();
    const pending = text ? text.split("\n") : [];
    for (const line of pending.slice(handled)) {
      const request = JSON.parse(line) as { kind: string; line: string };
      if (request.kind === "run") f.sendLine(request.line);
      else if (outcome === "delayed") timer = setTimeout(() => f.closeNativeInput(), 50);
    }
    handled = pending.length;
  });
  writeFileSync(
    runtimeBinary(config),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { readPaneState } from ${JSON.stringify(modules.state)};
import { processIdentity } from ${JSON.stringify(modules.process)};
const at = process.argv.indexOf("pane");
const operation = process.argv[at + 1];
if (operation === "send-keys") {
  const journal = JSON.parse(readFileSync(${JSON.stringify(f.journal)}, "utf8"));
  if (!journal.nativeUiExitRequestedAt || process.argv[at + 3] !== "ctrl+d") throw new Error("unbound UI request");
  appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ kind: "key", line: "ctrl+d" }) + "\\n");
  process.exit(91);
}
if (operation === "run") {
  appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ kind: "run", line: process.argv[at + 3] }) + "\\n");
  console.log(JSON.stringify({ result: {} }));
  process.exit(0);
}
if (operation === "read") {
  console.log("╭── Native context ───╮\\n╰─    ⇧⇥ to change thinking effort ─╯");
  process.exit(0);
}
const state = readPaneState(${JSON.stringify(config.stateDir)}, ${JSON.stringify(config.pane)});
const owner = state && processIdentity(state.pid);
const root = ${f.front.shell_pid};
const group = pid => Number(readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(" ")[2]);
const pids = owner ? [owner.pid, ...readFileSync("/proc/" + owner.pid + "/task/" + owner.pid + "/children", "utf8").trim().split(/\\s+/).filter(Boolean).map(Number)] : [root];
const front = { shell_pid: root, foreground_process_group_id: owner ? group(owner.pid) : root,
  foreground_processes: pids.filter(pid => processIdentity(pid)).map(pid => ({ pid,
    name: readFileSync("/proc/" + pid + "/comm", "utf8").trim(),
    argv: readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean),
  })),
};
if (operation !== "get" && operation !== "process-info") throw new Error("unexpected pane operation");
const result = operation === "get"
  ? { pane: owner ? { agent: "omp", agent_status: state.agentStatus } : {} }
  : { process_info: front };
console.log(JSON.stringify({ result }));
`,
    { mode: 0o700 },
  );
  // Publish admission after setup; /tmp can assign an mtime just before a same-millisecond clock sample.
  const pulse = new Date();
  writeFileSync(f.bootstrap.intake.path, String(pulse.getTime()), { mode: 0o600 });
  utimesSync(f.bootstrap.intake.path, pulse, pulse);
  return {
    ...f,
    config,
    requests,
    closeRequests: () => {
      watcher.close();
      clearTimeout(timer);
    },
  };
}

import assert from "node:assert/strict";
import { join } from "node:path";
import { recordExecution } from "../../../skills/cataly-mode/scripts/src/lane-run.ts";
import { quoteForPane } from "../../../skills/cataly-mode/scripts/src/launch-footer.ts";
import { Registry } from "../../../skills/cataly-mode/scripts/src/registry.ts";
import { Reports } from "../../../skills/cataly-mode/scripts/src/reports.ts";
import { assertNativeHost } from "./host.ts";

const [root, home] = process.argv.slice(2);
assert(root && home);
const host = process.env["CATALY_TEST_OMP_ROOT"];
const runId = process.env["CATALY_LANE_RUN"];
assert(host && runId);
let networkAttempts = 0;
const noNetwork = (): never => {
  networkAttempts++;
  throw new Error("Request run fixture must not make a network request");
};
globalThis.fetch = Object.assign(async () => noNetwork(), { preconnect: noNetwork });
await assertNativeHost();
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
const { BashTool } = await import(join(host, "src/tools/bash.ts"));
const { releaseShellSessions } = await import(join(host, "src/exec/bash-executor.ts"));
const settings = Settings.isolated({});
const stateDir = join(home, "state");
const config = join(home, "cataly.json");
await Bun.write(config, JSON.stringify({ stateDir, defaultCwd: home }));
process.env["CATALY_CONFIG"] = config;
const lane = {
  key: "native-request", title: "Native Bash request", thread: "none", brief: "/brief", done: "file /done",
  openedAt: new Date().toISOString(), reportProtocol: "jsonl-v1", requestId: "discord:111111111111111111:222222222222222222",
  runId, session: "native-bash-request", sessionRef: { runtime: "tern", id: "9" },
} as const;
await new Registry(stateDir).write(lane);
recordExecution(stateDir, lane, Date.now());
recordExecution(stateDir, lane, Date.now(), lane.session);
const tool = new BashTool({
  cwd: home, hasUI: false, settings,
  getSessionId: () => lane.session, getSessionFile: () => null, getSessionSpawns: () => null,
});
try {
  const argv = [process.execPath, "--no-env-file", join(root, "skills/cataly-mode/scripts/src/cli.ts"),
    "report", lane.key, "--kind", "milestone", "--text", "Native Bash inherited the launch run", "--json"];
  const result = await tool.execute("request-report", { command: argv.map(quoteForPane).join(" "), cwd: home, timeout: 10 });
  // Native Bash omits exitCode on success; nonzero exits and timeouts set isError.
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.details?.exitCode, undefined, JSON.stringify(result));
  const report = new Reports(stateDir).read(lane.key)?.lastReport;
  assert.equal(report?.provenance?.runId, runId);
  assert.equal(report?.provenance?.nativeRef?.sessionId, lane.session);
  assert.equal(report?.provenance?.requestId, lane.requestId);
  assert.equal(networkAttempts, 0);
  const nativeVersion = (await Bun.file(join(host, "package.json")).json()).version;
  console.log(JSON.stringify({ runId, requestId: lane.requestId, networkAttempts, nativeVersion }));
} finally {
  releaseShellSessions(lane.session);
}

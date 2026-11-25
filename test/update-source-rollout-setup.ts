import { lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { captureRuntime, startHarness } from "../src/update/deployment-harness.ts";
import { loadSourceUpdateConfig } from "../src/update/source-update-config.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";
import { gitSourceFixture } from "./update-source-git-setup.ts";

const activityModule = resolve(import.meta.dir, "../src/update/source-activity.ts");

/**
 * A real native harness on an ordinary Git source checkout. Only the GitHub transport is recorded; Git, Bun, the
 * headless broker, `cataly up|stop`, pointer switches and health receipts are real. Every lead incarnation starts its
 * own inbound activity receiver as a descendant, quiet for longer than the owner quiet period.
 */
export async function sourceRolloutFixture() {
  let rejected: string | undefined;
  let monitors: ((sessionId: string) => void) | undefined;
  const d = await headlessDeployment({
    start: false,
    // A rejected source prefix makes its lead's extension report an unloaded preset.
    healthy: (source) => rejected === undefined || !source.startsWith(rejected),
    // The fake OMP lives in <root>/h/omp-bin; the receiver and the state directory sit at fixed offsets from it. The
    // receiver runs exactly the argv its session's monitor manifest names, so the lead's health reports it.
    // It is unreferenced so the lead exits on RPC EOF like real OMP; it follows its parent out.
    prelude: `const at = (path) => new URL(path, import.meta.url).pathname;
const ready = at("../../receiver-ready-" + process.pid);
Bun.spawn([process.execPath, at("../../receiver.ts"), at("../c/s/activity/discord.json")], { env: { ...process.env, RECEIVER_READY: ready }, stdio: ["ignore", "ignore", "inherit"] }).unref();
for (const until = Date.now() + 10_000; !(await Bun.file(ready).exists()) && Date.now() < until; ) await Bun.sleep(10);`,
    onLead: ({ sessionId }) => monitors?.(sessionId),
  });
  try {
    const activity = join(d.config.stateDir, "activity", "discord.json");
    const receiver = join(d.root, "receiver.ts");
    if (activity !== resolve(d.root, "h/c/s/activity/discord.json")) throw new Error("fixture layout changed");
    writeFileSync(
      receiver,
      `import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inboundActivity } from ${JSON.stringify(activityModule)};
const activity = resolve(process.argv[2]);
const ready = process.env.RECEIVER_READY;
const parent = process.ppid;
let clock = Date.now() - 1_900_000;
let writer;
// The previous lead's receiver releases its writer lease when that lead exits.
for (const deadline = Date.now() + 10_000; !writer; ) {
  try {
    writer = inboundActivity(activity, "discord", () => clock);
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    await Bun.sleep(25);
  }
}
writer.healthy();
clock = Date.now();
writer.healthy();
writeFileSync(ready, String(process.pid));
const stop = () => { clearInterval(timer); writer.close(); process.exit(0); };
const timer = setInterval(() => {
  if (process.ppid !== parent) stop();
  clock = Date.now();
  writer.healthy();
}, 200);
process.on("SIGTERM", stop);
`,
    );
    const path = join(d.root, "source-update.json");
    const git = Bun.which("git");
    if (!git) throw new Error("source rollout tests require Git");
    const settings = { version: 1, git, gh: process.execPath, activityFiles: [activity], deployment: d.config };
    saveDeploymentJson(path, settings);
    const f = await gitSourceFixture({ root: d.root, path, settings, config: loadSourceUpdateConfig(path) });
    // Managed prepareRelease also resolves its Git through the private Bun directory.
    const bun = join(dirname(f.config.git), "bun");
    symlinkSync(process.execPath, bun);
    saveDeploymentJson(path, { ...f.settings, deployment: { ...f.config.deployment, bun } });
    const config = loadSourceUpdateConfig(path);

    // Each lead session names the managed intake its receiver feeds, as the real lead's monitor manifest does.
    const manifests = new Set<string>();
    monitors = (sessionId) => {
      if (manifests.has(sessionId)) return;
      const desired = join(config.deployment.stateDir, "monitors", `${encodeURIComponent(sessionId)}.json`);
      if (!lstatSync(desired, { throwIfNoEntry: false }))
        saveDeploymentJson(desired, {
          version: 1,
          sessionId,
          monitors: [{ name: "discord", argv: [process.execPath, receiver, activity], filter: ".*", cwd: d.root }],
          intake: { monitor: "discord", path: `${activity}.heartbeat`, maxAgeMs: 90_000 },
        });
      manifests.add(sessionId);
    };
    await startHarness(config.deployment, d.oldSource, { ...d.toolchain, bun, extensionSource: d.oldSource }, d.work);
    const lead = await d.until(async () => {
      const seen = await d.lead();
      return seen?.status === "idle" && seen.sessionId && manifests.has(seen.sessionId) ? seen : undefined;
    }, "an idle lead with its activity receiver");
    const runtime = await captureRuntime(config.deployment);

    const lanes = join(config.deployment.stateDir, "lanes");
    const lane = join(lanes, "late-owner-work.json");
    const laneRecord = { key: "late-owner-work", status: "working" };
    const laneFlag = join(d.root, "open-lane-on-github");
    // When flagged, the recorded GitHub transport opens a lane: after the first idle check, before stop admission.
    writeFileSync(
      f.settings.gh,
      readFileSync(f.settings.gh, "utf8").replace(
        "\n",
        `
import { existsSync as laneFlagged, mkdirSync as laneDirectory, writeFileSync as laneWrite } from "node:fs";
if (laneFlagged(${JSON.stringify(laneFlag)})) {
  laneDirectory(${JSON.stringify(lanes)}, { recursive: true });
  laneWrite(${JSON.stringify(lane)}, ${JSON.stringify(JSON.stringify(laneRecord))});
}
`,
      ),
    );
    return {
      ...f,
      config,
      deployment: d,
      lead,
      runtime,
      activity,
      lane,
      sourceState: join(config.deployment.releaseRoot, "source-update.json"),
      openLane: (): void => saveDeploymentJson(lane, laneRecord),
      openLaneOnGitHub: (): void => writeFileSync(laneFlag, ""),
      closeLane: (): void => {
        rmSync(laneFlag, { force: true });
        rmSync(lane, { force: true });
      },
      /** Leads loaded from a source under `prefix` report failed health until cleared with `undefined`. */
      rejectHealth: (prefix: string | undefined): void => {
        rejected = prefix;
      },
      close: () => d.teardown(),
    };
  } catch (error) {
    await d.teardown();
    throw error;
  }
}

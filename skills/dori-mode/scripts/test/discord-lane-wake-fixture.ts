import { chmodSync, writeFileSync } from "node:fs";
import type { FlowDeps } from "../src/done-flow.ts";
import type { PaneState } from "../src/lane-state.ts";
import { type Lane, sessionFields } from "../src/registry.ts";
import { agentIn, laneState, type TestState, type World } from "./fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

export const prior = { runtime: "herdr", id: "w1:p7", group: "w1", container: "w1:t7" } as const;
export const next = { runtime: "herdr", id: "w1:p8", group: "w1", container: "w1:t8" } as const;
export const replacement = { runtime: "herdr", id: "w2:p1", group: "w2", container: "w2:t1" } as const;
export const nativePid = 4250;
export const executable = "/opt/configured/bin/omp";
const testHerdr = "discord-test";
const ownersDir = "/dori-test/owners";
const leaseInode = "2193939";
const savedModel = "saved-provider/saved-model";
const ok = (out = "") => ({ code: 0, out, err: "" });
const failed = { code: 1, out: "", err: "request rejected or receipt lost" } as const;

type Controls = {
  shellBusy: boolean;
  leaseHeld: boolean;
  loseStartReceipt: boolean;
  keepWorkspace: boolean;
  delayStartup: boolean;
  leaseOwner: number | undefined;
  creates: number;
  starts: number;
};

export type WakeFixture = {
  readonly state: TestState;
  readonly world: World;
  readonly file: string;
  readonly session: string;
  readonly lane: Lane;
  readonly deps: FlowDeps;
  readonly control: Controls;
  readonly attachStartedPane: (patch?: Partial<PaneState>) => void;
};

export async function wakeFixture(): Promise<WakeFixture> {
  const fixture = await lifecycleFixture();
  const { state, world, file, session } = fixture;
  const cwd = fixture.deps.config.defaultCwd;
  writeFileSync(
    file,
    [
      { type: "title", title: "Saved title" },
      { type: "session", id: session, cwd },
      { type: "model_change", id: "default", parentId: null, model: "initial/default" },
      { type: "model_change", id: "selected", parentId: "default", role: "slow", model: savedModel },
      { type: "model_change", id: "other-branch", parentId: "default", model: "other/model", activeLeafId: "selected" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  chmodSync(file, 0o664);
  const lane: Lane = {
    ...fixture.lane,
    ...sessionFields(prior),
    thread: "discord:100000000000000001",
    worktrees: [cwd],
    status: "not-done",
  };
  await fixture.deps.registry.write(lane);
  world.panes = [{ pane_id: "w1:p9", workspace_id: "w1", foreground: "bash" }];
  world.procs = [];
  laneState(state.dir, prior.id, { cwd, pid: 0, sessionFile: file, discordLaneInbox: true });
  const control: Controls = {
    shellBusy: false,
    leaseHeld: false,
    loseStartReceipt: false,
    keepWorkspace: true,
    delayStartup: false,
    leaseOwner: undefined,
    creates: 0,
    starts: 0,
  };
  const attachStartedPane = (patch: Partial<PaneState> = {}) => {
    const ref = control.keepWorkspace ? next : replacement;
    world.panes = world.panes.filter((pane) => pane.pane_id !== ref.id);
    world.panes.push({ pane_id: ref.id, workspace_id: ref.group, agent: "omp", agent_status: "idle", cwd });
    agentIn(world, ref.id, nativePid);
    laneState(state.dir, ref.id, { cwd, pid: nativePid, sessionFile: file, discordLaneInbox: true, ...patch });
  };
  const deps: FlowDeps = {
    ...fixture.deps,
    env: { ...fixture.deps.env, DORI_HERDR_SESSION: testHerdr, PI_TEST_SESSION_OWNERS_DIR: ownersDir },
    config: {
      ...fixture.deps.config,
      agentCommand: [executable, "--dori-role", "lane", "--model", "{model}", "{prompt}"],
      defaultModel: "configured/default-model",
      guard: { ...fixture.deps.config.guard, memFreeMinPct: 0, diskFreeMinGb: 1 },
    },
    run: async (full, options) => {
      const [cmd] = full;
      const shell = control.keepWorkspace ? next : replacement;
      if (cmd === "df")
        return ok("Filesystem 1024-blocks Used Available Capacity Mounted on\nfs 8000000 0 8000000 0% /");
      if (cmd === executable && full[1] === "session" && full[2] === "lease" && full.at(-1) === session) {
        const held = control.leaseHeld || control.leaseOwner !== undefined ? [session] : [];
        return ok(JSON.stringify({ held, unknown: [] }));
      }
      if (cmd === "cat" && full[1] === "/proc/net/unix") {
        const lockPath = `${ownersDir}/${session}.lock`;
        const hash = [0x4f4d502d4c4f434bn, 0x50492d46494c454cn]
          .map((seed) => Bun.hash.xxHash64(lockPath, seed).toString(16).padStart(16, "0"))
          .join("");
        return ok(`ffffde558b448800: 00000002 00000000 00000000 0002 03 ${leaseInode} @omp-file-lock-${hash}`);
      }
      if (cmd === "find")
        return ok(
          full[1] === `/proc/${control.leaseOwner}/fd` ? `pipe:[125]\nsocket:[${leaseInode}]` : "socket:[2193940]",
        );
      if (cmd !== "herdr") return fixture.deps.run(full, options);
      if (full[1] !== "--session" || full[2] !== testHerdr) return failed;
      const argv = [cmd, ...full.slice(3)];
      const [, scope, action, id] = argv;
      if (scope === "pane" && action === "process-info" && argv[4] === shell.id && control.starts === 0) {
        return ok(
          JSON.stringify({
            result: {
              process_info: {
                pane_id: shell.id,
                shell_pid: nativePid - 1,
                foreground_process_group_id: control.shellBusy ? 4251 : nativePid - 1,
                foreground_processes: control.shellBusy
                  ? [{ name: "bash", argv: ["bash", "-c", "running job"], pid: 4251 }]
                  : [{ name: "bash", argv: ["bash"], pid: nativePid - 1 }],
              },
            },
          }),
        );
      }
      if (action === "create" && (scope === "tab" || scope === "workspace")) {
        control.creates++;
        if (
          scope !== (control.keepWorkspace ? "tab" : "workspace") ||
          (control.keepWorkspace
            ? argv[argv.indexOf("--workspace") + 1] !== prior.group
            : argv.includes("--workspace")) ||
          !argv.includes("--no-focus") ||
          !argv.includes(`DORI_DISCORD_WAKE_SESSION=${session}`) ||
          !argv.includes("DORI_DISCORD_WAKE_GOAL=active") ||
          !argv.includes(`DORI_DISCORD_WAKE_MODEL=${savedModel}`)
        )
          return failed;
        world.panes.push({ pane_id: shell.id, workspace_id: shell.group, cwd, foreground: "bash" });
        return ok(
          JSON.stringify({
            result: { root_pane: { pane_id: shell.id, workspace_id: shell.group, tab_id: shell.container } },
          }),
        );
      }
      if (scope === "pane" && action === "run") {
        control.starts++;
        const words = argv[4]?.split(" ");
        if (
          id !== shell.id ||
          !words ||
          words[0] !== executable ||
          !words.includes(`--resume=${file}`) ||
          !words[words.indexOf("--config") + 1]?.endsWith("/discord-lane-wake.yml") ||
          words.some((word) => word === "--model" || word.startsWith("--model=") || word === "{prompt}")
        )
          return failed;
        if (!control.delayStartup) {
          attachStartedPane();
          control.leaseOwner = nativePid;
        }
        return control.loseStartReceipt ? failed : ok();
      }
      return fixture.deps.run(argv, options);
    },
  };
  return { state, world, file, session, lane, deps, control, attachStartedPane };
}

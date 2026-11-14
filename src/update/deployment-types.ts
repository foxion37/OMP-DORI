import type { SourceManifest } from "./types.ts";

export type DeploymentConfig = {
  readonly releaseRoot: string;
  readonly liveSource: string;
  readonly home: string;
  readonly doriHome: string;
  readonly doriConfig: string;
  /** Dori's pane/monitor metadata root; native session files stay where they are. */
  readonly stateDir: string;
  readonly bun: string;
  readonly omp: string;
  readonly legacyOmp?: string;
  readonly herdr: string;
  readonly herdrSession?: string;
  readonly pane: string;
  readonly sessionId: string;
  readonly model: string;
  /** A directory lock shared with the managed model-watch launcher. */
  readonly restartLock: string;
  readonly launcherPath: string;
  readonly healthTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly monitorBootstrapFile?: string;
  readonly quiesceCheckpointFile?: string;
  readonly shims: readonly { readonly path: string; readonly source: string }[];
};
export type DeploymentInput = {
  readonly remote: string;
  readonly commit: string;
  readonly tree: string;
  readonly sourceHash: string;
  readonly candidate: string;
  readonly publicManifest: SourceManifest;
};
export type ProcessIdentity = {
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
  readonly executable: string;
  readonly imageDev?: string;
  readonly imageIno?: string;
};
export type RuntimeIdentity = ProcessIdentity & {
  readonly pane: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly startedAt: string;
  readonly cwd: string;
  readonly role: "dori";
  readonly busy?: boolean;
  readonly approvalPending?: boolean;
  readonly executableHash?: string;
  readonly nativeVersion?: string;
  readonly entrypointHash?: string;
};
export type ToolchainReceipt = {
  readonly omp: string;
  readonly bun: string;
  readonly nativeVersion: string;
  readonly ompEntry: string;
  readonly ompEntryHash: string;
  readonly bunHash: string;
  readonly nativeConfig: string;
  readonly nativeConfigHash: string;
};
export type MonitorSpec = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly cwd: string;
};
export type MonitorProcessIdentity = ProcessIdentity & { readonly name: string; readonly argv: readonly string[] };
export type IntakeSpec = { readonly path: string; readonly monitor: string; readonly maxAgeMs: number };
export type MonitorSet = {
  readonly version: 1;
  readonly sessionId: string;
  readonly monitors: readonly MonitorSpec[];
  readonly intake: IntakeSpec;
  readonly runtime?: ProcessIdentity & Pick<RuntimeIdentity, "pane" | "role" | "sessionId" | "startedAt">;
  readonly running?: readonly {
    readonly name: string;
    readonly pid: number;
    readonly identity?: ProcessIdentity;
  }[];
};
export type PointerRecord = {
  readonly path: string;
  readonly target: string;
  readonly backup: string;
  readonly displaced: string;
  readonly original?: {
    readonly dev: number;
    readonly ino: number;
    readonly kind: "directory" | "link" | "file";
    readonly target?: string;
  };
};
export type DeploymentStatus =
  | "prepared"
  | "stopping"
  | "switching"
  | "starting"
  | "healthy"
  | "rolled-back"
  | "held"
  | "failed";
export type DeploymentRecord = {
  readonly version: 1;
  readonly id: string;
  readonly inputHash: string;
  readonly configHash: string;
  readonly commit: string;
  readonly tree: string;
  readonly sourceHash: string;
  readonly releasePath: string;
  readonly directory: string;
  readonly createdAt: string;
  status: DeploymentStatus;
  retryableHold?: boolean;
  /** Fixed on the first pre-stop command/lock failure; a verified busy handoff ends that failure window. */
  retryDeadlineAt?: string;
  step: "prepare" | "stop" | "switch" | "start" | "health" | "rollback" | "done";
  preparedAt?: string;
  toolchain?: ToolchainReceipt;
  oldToolchain?: ToolchainReceipt;
  oldSource?: string;
  oldSourceHash?: string;
  oldRuntime?: RuntimeIdentity;
  oldMonitors?: readonly MonitorProcessIdentity[];
  monitors?: MonitorSet;
  bootstrap?: boolean;
  quiesceHash?: string;
  pointers?: readonly PointerRecord[];
  stopRequestedAt?: string;
  launchRequestedAt?: string;
  runtime?: RuntimeIdentity;
  launchProcess?: ProcessIdentity;
  runtimeMonitors?: readonly MonitorProcessIdentity[];
  rollbackRequestedAt?: string;
  rollbackLaunchRequestedAt?: string;
  rollbackRuntime?: RuntimeIdentity;
  rollbackProcess?: ProcessIdentity;
  healthyAt?: string;
  rollbackHealthyAt?: string;
  error?: string;
};
export type RuntimeHealth = {
  readonly version: 1;
  readonly paneId: string;
  readonly pid: number;
  readonly sessionId: string;
  readonly role: string;
  readonly presetLoaded: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly source: string;
  readonly extensionHash: string;
  readonly monitors: readonly (MonitorSpec & { readonly pid: number; readonly startTicks: string })[];
};

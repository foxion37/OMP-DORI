import type { NativeReceipt } from "../release/native.ts";
import type { SourceManifest } from "./types.ts";

/** The managed target is the native headless harness owned by `catalyHome` (its `harness-native.json`). */
export type DeploymentConfig = {
  readonly releaseRoot: string;
  readonly liveSource: string;
  readonly home: string;
  readonly catalyHome: string;
  readonly catalyConfig: string;
  /** The harness's native state directory: reservations, runtime health and monitor metadata. */
  readonly stateDir: string;
  readonly bun: string;
  /** Omitted selects the release-bound native source; an absolute path is an explicit external-toolchain override. */
  readonly omp?: string;
  /** A directory lock shared with the managed restart launcher. */
  readonly restartLock: string;
  readonly launcherPath: string;
  readonly healthTimeoutMs: number;
  readonly stopTimeoutMs: number;
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
/** The harness lead's OMP process, bound to its headless reservation and native session. */
export type RuntimeIdentity = ProcessIdentity & {
  /** The lead's headless reservation id (`headless:<ref>`). */
  readonly ref: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  /** The reservation's start time. */
  readonly startedAt: string;
  readonly cwd: string;
  readonly role: "cataly";
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
  /** The bound native source, or `nativeOverride` for an explicitly configured executable. */
  readonly nativeSource?: NativeReceipt;
  readonly nativeOverride?: true;
  /** Source whose `extension/` the managed command pins in place of discovered extensions. */
  readonly extensionSource: string;
  readonly nativeConfigHash: string;
};
export type MonitorSpec = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly cwd: string;
  readonly mode?: "once" | "daemon";
  readonly restart?: "on-failure" | { readonly max: number; readonly backoffSec: number };
  readonly silentAfterMin?: number;
};
export type MonitorProcessIdentity = ProcessIdentity & { readonly name: string; readonly argv: readonly string[] };
export type IntakeSpec = { readonly path: string; readonly monitor: string; readonly maxAgeMs: number };
export type MonitorSet = {
  readonly version: 1 | 3;
  readonly sessionId: string;
  readonly monitors: readonly MonitorSpec[];
  readonly intake: IntakeSpec;
  /** A historical trusted bootstrap receipt; parsed for the extension's bootstrap reader. */
  readonly runtime?: ProcessIdentity & {
    readonly pane: string;
    readonly role: "cataly";
    readonly sessionId: string;
    readonly startedAt: string;
  };
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
  "prepared" | "stopping" | "switching" | "starting" | "healthy" | "rolled-back" | "held" | "failed";
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
  /** The old lead session's desired monitors and intake, captured before its stop; the resumed lead restores them. */
  monitors?: MonitorSet;
  quiesceHash?: string;
  pointers?: readonly PointerRecord[];
  stopRequestedAt?: string;
  /** The old lead was already gone when the stop was first attempted. */
  nativeExitObservedAt?: string;
  launchRequestedAt?: string;
  runtime?: RuntimeIdentity;
  runtimeMonitors?: readonly MonitorProcessIdentity[];
  rollbackRequestedAt?: string;
  rollbackLaunchRequestedAt?: string;
  rollbackRuntime?: RuntimeIdentity;
  healthyAt?: string;
  rollbackHealthyAt?: string;
  error?: string;
  rollbackError?: string;
};
export type RuntimeHealth = {
  readonly version: 1;
  /** The writer's session address: a headless reservation id. */
  readonly paneId: string;
  readonly pid: number;
  readonly sessionId: string;
  readonly role: string;
  readonly configLoaded: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly source: string;
  readonly extensionHash: string;
  readonly monitors: readonly (MonitorSpec & { readonly pid: number; readonly startTicks: string })[];
};

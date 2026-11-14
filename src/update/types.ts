import type { PromotionConfig, PromotionRecord } from "./publish-types.ts";
import type { ReviewScope } from "./reviewer-guard.ts";
import type { WorkerScope } from "./worker-guard.ts";

export type UpdatePhase =
  | "prepared"
  | "porting"
  | "verifying"
  | "reviewing"
  | "ready"
  | "failed"
  | "rejected"
  | "interrupted";
export type UpdateCommand = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly engine?: "omp" | "external";
};
export type UpdateConfig = {
  readonly version: 1;
  readonly target: "dori";
  readonly runtime: "herdr";
  readonly root: string;
  readonly remote: string;
  readonly ref: string;
  readonly baseUpstream: string;
  readonly localSource: string;
  readonly intervalSeconds: number;
  readonly worker: UpdateCommand;
  readonly reviewer: UpdateCommand;
  readonly provision: readonly UpdateCommand[];
  readonly checks: readonly UpdateCommand[];
  /** Names only. Values are inherited for model clients, never for checks or source snapshots. */
  readonly modelEnv: readonly string[];
  /** Trusted client auth/settings capability; never copied. Sessions and generated configs remain isolated. */
  readonly modelAgentDir?: string;
  readonly reporter?: UpdateCommand;
  readonly reporterEnv: readonly string[];
  /** Omitted means staging only. Standing publication/deployment authority is explicit and hash-bound. */
  readonly promotion?: PromotionConfig;
};
export type SourceEntry = { readonly path: string; readonly sha256: string; readonly executable: boolean };
export type SourceManifest = {
  readonly version: 1;
  readonly hash: string;
  readonly files: readonly SourceEntry[];
  readonly excluded: readonly string[];
  /** Source snapshots bind even an empty or absent opaque local ULW library; application-data manifests omit this. */
  readonly ulwPresent?: boolean;
};
export type UpdateInputs = {
  readonly baseUpstream: string;
  readonly upstream: string;
  readonly base: SourceManifest;
  readonly local: SourceManifest;
  readonly incoming: SourceManifest;
  readonly changedPaths: readonly string[];
};
export type CommandReceipt = {
  readonly name: string;
  readonly argvHash: string;
  readonly startedAt: string;
  finishedAt?: string;
  pid?: number;
  readonly workerScopePath?: string;
  workerScope?: WorkerScope;
  exitCode?: number;
  signal?: NodeJS.Signals | number;
  error?: string;
  readonly sourceHash?: string;
  readonly model?: {
    readonly requested: string | null;
    observed: string | null;
    readonly requestedThinking: string | null;
  };
  readonly reviewScopePath?: string;
  reviewScope?: ReviewScope;
  readonly stdout: string;
  readonly stderr: string;
};
export const REVIEW_ITEMS = [
  "upstreamCoverage",
  "localAdaptations",
  "correctness",
  "isolation",
  "verification",
  "security",
  "failureRecovery",
  "scope",
] as const;
export type ReviewItem = (typeof REVIEW_ITEMS)[number];
export type UpdateReview = {
  readonly version: 1;
  readonly sourceHash: string;
  readonly verdict: "approve" | "reject";
  readonly checklist: Readonly<
    Record<ReviewItem, { readonly status: "pass" | "fail" | "unknown"; readonly evidence: string }>
  >;
  readonly findings: readonly string[];
  readonly limitations: readonly string[];
};
export type PortResult = {
  readonly version: 1;
  readonly baseHash: string;
  readonly localHash: string;
  readonly upstreamHash: string;
  readonly coverage: readonly {
    readonly path: string;
    readonly disposition: "preserved" | "adapted" | "removed";
    readonly evidence: string;
  }[];
};
export type PreActionNotice = {
  readonly job: string;
  readonly action: "main-publication" | "dori-replacement";
  readonly intentHash: string;
  readonly commandIndex: number;
  state: "sending" | "accepted" | "failed" | "ambiguous";
  exitCode?: number;
};
export type UpdateJob = {
  readonly version: 1;
  readonly id: string;
  readonly upstream: string;
  readonly baseUpstream: string;
  readonly configHash: string;
  readonly createdAt: string;
  updatedAt: string;
  phase: UpdatePhase;
  readonly candidate: string;
  readonly directory: string;
  inputs?: UpdateInputs;
  sourceHash?: string;
  port?: PortResult;
  review?: UpdateReview;
  readonly commands: CommandReceipt[];
  readonly history: { readonly phase: UpdatePhase; readonly at: string }[];
  problem?: string;
  promotion?: PromotionRecord;
  notification?: { readonly state: "sending" | "sent" | "failed" | "ambiguous"; readonly exitCode?: number };
  preActionNotices?: Partial<Record<PreActionNotice["action"], PreActionNotice>>;
};
export type UpdateState = {
  readonly version: 1;
  readonly configHash: string;
  observed?: string;
  processed?: string;
  /** Effective upstream baseline advances only after all configured publication/deployment readbacks succeed. */
  baseline?: string;
  active?: string;
  /** Write-once ownership of the explicitly reviewed initial-source exception, retained after failure or rollback. */
  initialSourceJob?: string;
  readonly jobs: Record<string, string>;
};
export type UpdateEvent = {
  readonly type: "DORI_UPDATE";
  readonly target: "dori";
  readonly event: string;
  readonly job?: string;
  readonly phase?: UpdatePhase;
  readonly upstream?: string;
};
export type UpdateLock = {
  readonly version: 1;
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
  readonly at: string;
};
export type UpdateContext = {
  readonly config: UpdateConfig;
  readonly configHash: string;
  readonly emit: (event: UpdateEvent) => void;
  readonly signal?: AbortSignal;
};

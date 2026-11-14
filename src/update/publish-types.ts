import { UpdateError } from "./config.ts";
import type { DeploymentConfig, DeploymentRecord } from "./deployment.ts";

/** Admission/identity failures are terminal; remote operation errors retain their retryable intent. */
export class PublicationHold extends UpdateError {}

export type InitialSourcePins = {
  readonly main: string;
  readonly sourceHash: string;
  readonly exportHash: string;
  readonly baseUpstream: string;
  readonly upstream: string;
};
export type PublicationBasis =
  | { readonly kind: "matched-main" }
  | { readonly kind: "initial-source"; readonly pins: InitialSourcePins };

export type PublishConfig = {
  readonly remote: string;
  readonly ref: string;
  readonly author: { readonly name: string; readonly email: string };
  /** One exact reviewed historical replay input/export and owner-main binding, claimed by a single durable job. */
  readonly initialSource?: InitialSourcePins;
  /** Only the trusted controller may use this installed gh and its existing HOME auth capability. */
  readonly github?: {
    readonly gh: string;
    readonly credentialHome: string;
    readonly requiredChecks: readonly string[];
  };
};
export type PromotionConfig = {
  readonly publish: PublishConfig;
  readonly deployment?: DeploymentConfig;
};
export type PublicationRecord = {
  readonly version: 1;
  status: "prepared" | "branch-pushing" | "awaiting-ci" | "main-pushing" | "published" | "held";
  readonly remote: string;
  readonly ref: string;
  readonly branch: string;
  readonly expectedMain: string;
  readonly basis: PublicationBasis;
  readonly sourceHash: string;
  readonly exportHash: string;
  readonly createdAt: string;
  updatedAt: string;
  commit?: string;
  tree?: string;
  prIntent?: boolean;
  pullRequest?: number;
  ci?: { readonly head: string; readonly checks: readonly string[]; readonly at: string };
  ciWait?: { readonly startedAt: string; readonly deadlineAt: string };
  problem?: string;
};
export type PromotionRecord = {
  readonly version: 1;
  status: "publishing" | "deploying" | "complete" | "held";
  publication?: PublicationRecord;
  notifications?: Record<
    string,
    { readonly state: "sending" | "sent" | "failed" | "ambiguous"; readonly exitCode?: number }
  >;
  deployment?: DeploymentRecord;
  problem?: string;
  completedAt?: string;
};

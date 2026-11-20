import { resolve } from "node:path";

/** Provenance of matching launch text, not assignment history or proof of native activation or an active goal. */
export type LaunchSelection = {
  readonly invocation: string;
  readonly selectedBy: "default" | "config" | "provided";
  readonly reason: string;
};

export type LaunchConfig = {
  readonly launchKeywords: string;
  readonly launchSelection?: LaunchSelection;
};

// Derive this at load time, after the raw JSON spread: a file cannot supply its own claimed origin.
export const launchConfig = (invocation = "ulw set goal and work", path?: string): LaunchConfig => ({
  launchKeywords: invocation,
  launchSelection: {
    invocation,
    selectedBy: path === undefined ? "default" : "config",
    reason: path === undefined ? "Built-in launchKeywords default" : `launchKeywords from ${resolve(path)}`,
  },
});

// Same-text programmatic assignments retain matching provenance; normalized objects have no assignment history.
// A different invocation must not retain stale provenance.
export const selectionFor = (config: LaunchConfig): LaunchSelection =>
  config.launchSelection?.invocation === config.launchKeywords
    ? config.launchSelection
    : {
        invocation: config.launchKeywords,
        selectedBy: "provided",
        reason: "Direct launchKeywords configuration without matching load provenance",
      };

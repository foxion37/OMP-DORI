import type { ModelReadback } from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import type { HeadlessObservation } from "./headless-protocol.ts";

export const LAUNCH_MODEL_FLAG = "cataly-launch-model";
export const LAUNCH_MODEL_OPTION = `--${LAUNCH_MODEL_FLAG}=`;
export const HEADLESS_LAUNCH_MODEL_ENTRY = "omp-cataly:headless-launch-model";

export type HeadlessBeginOutcome = HeadlessObservation & { readonly modelReadback: ModelReadback };

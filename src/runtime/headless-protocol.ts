import type { AgentStatus, DeliverOptions, Probe, SessionRef } from "./types.ts";
import type { HeadlessRemoteRequest } from "./headless-remote.ts";

export type NativeHarnessRole = "lead" | "duty";
export type NativeLoopRole = "duty-loop" | "hourly-loop";

export type HeadlessGoal = {
  readonly status: "none" | "active" | "paused" | "complete" | "dropped" | "blocked";
  readonly objective?: string;
};
export type HeadlessQuestion = {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly multi: boolean;
};
export type HeadlessDialog = {
  readonly id: string;
  readonly kind: "approval" | "confirm" | "select" | "input" | "editor" | "ask" | "unsupported";
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly string[];
  readonly questions?: readonly HeadlessQuestion[];
  readonly secret?: true;
};
export type HeadlessAnswer =
  | { readonly cancelled: true }
  | { readonly confirmed: boolean }
  | { readonly value: string }
  | {
      readonly answers: readonly {
        readonly id: string;
        readonly selectedOptions: readonly string[];
        readonly customInput?: string;
      }[];
    };
export type HeadlessEntry = { readonly kind: "assistant" | "output" | "notice"; readonly text: string };
export type HeadlessObservation = {
  readonly ref: SessionRef;
  readonly cwd: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: AgentStatus;
  readonly pid?: number;
  readonly role?: "lane" | "cataly";
  readonly harnessRole?: NativeHarnessRole | NativeLoopRole;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly goal?: HeadlessGoal;
  readonly model?: string;
  readonly held: boolean;
  readonly dialogs: readonly HeadlessDialog[];
  readonly recent: readonly HeadlessEntry[];
  readonly activeSince?: number;
  readonly detail?: string;
};

export const headlessProbe = (seen: HeadlessObservation): Probe => ({
  status: seen.status,
  shellInFront: false,
  approvalPending: seen.held,
  cwd: seen.cwd,
  ...(seen.role ? { agent: "omp" } : {}),
  ...(seen.pid !== undefined ? { pid: seen.pid, rootPid: seen.pid } : {}),
  ...(seen.sessionId !== undefined ? { sessionId: seen.sessionId } : {}),
  ...(seen.sessionFile !== undefined ? { sessionFile: seen.sessionFile } : {}),
});

export const headlessRead = (seen: HeadlessObservation, lines: number): string => {
  if (lines <= 0) return "";
  const out = [
    ...seen.recent.map((entry) => entry.text),
    ...seen.dialogs.map((dialog) => {
      const detail = dialog.title ?? dialog.questions?.map((question) => question.question).join("; ") ?? "";
      return `[${dialog.kind} ${dialog.id}] ${Bun.stripANSI(detail)}`;
    }),
  ];
  return out.join("\n").split("\n").slice(-lines).join("\n");
};

export type HeadlessRequest =
  | HeadlessRemoteRequest
  | { readonly op: "observe" }
  | { readonly op: "stop-loop" }
  | { readonly op: "begin"; readonly expectedSessionId: string; readonly objective: string }
  | { readonly op: "deliver"; readonly text: string; readonly options: DeliverOptions }
  | { readonly op: "goal"; readonly expectedSessionId: string; readonly target: "paused" | "active" }
  | {
      readonly op: "answer";
      readonly expectedSessionId: string;
      readonly requestId: string;
      readonly answer: HeadlessAnswer;
    }
  | { readonly op: "close"; readonly expectedSessionId: string };

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

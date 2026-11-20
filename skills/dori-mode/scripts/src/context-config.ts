/** Context handoff and relay timing, shared by the context monitor and `dori relay`. */
export type ContextConfig = {
  /** Models matching this pattern hand off at `contextHandoffPct`; every other model at `contextHandoffPctOther`. */
  readonly contextClaudePattern: string;
  readonly contextHandoffPct: number;
  readonly contextHandoffPctOther: number;
  /** A lane with no context data this many minutes after it opened is reported CONTEXT_UNKNOWN once. */
  readonly contextUnknownAfterMin: number;
  /** How long `relay` waits for a lane to write its handoff. */
  readonly relayTimeoutMin: number;
};

export const contextConfig = (): ContextConfig => ({
  contextClaudePattern: "claude|opus|sonnet|haiku",
  contextHandoffPct: 40,
  contextHandoffPctOther: 60,
  contextUnknownAfterMin: 10,
  relayTimeoutMin: 10,
});

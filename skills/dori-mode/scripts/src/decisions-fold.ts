/** Folding decisions.jsonl in record order, remembering which writer's event each result came from. */
import {
  type Decision,
  DecisionError,
  type DecisionRead,
  type Event,
  isTorn,
  parseEvent,
  settled,
} from "./decisions-record.ts";

/**
 * The read, plus what a writer needs to judge its own event by nonce: why an event was ignored (or applied only in
 * part), and which event resolved each decision or bound its current message.
 */
export type DecisionFold = {
  readonly read: DecisionRead;
  readonly ignored: ReadonlyMap<string, string>;
  readonly resolvedBy: ReadonlyMap<string, string>;
  readonly boundBy: ReadonlyMap<string, string>;
};

const asked = ({
  id,
  at,
  question,
  source,
  lane,
  thread,
  kind,
  options,
  recommend,
  worklog,
}: Event & { op: "ask" }) => ({
  id,
  question,
  source,
  askedAt: at,
  ...(lane !== undefined ? { lane } : {}),
  ...(thread !== undefined ? { thread } : {}),
  // A question recorded before kinds existed, or without one, is the owner's to answer.
  kind: kind ?? "owner",
  options: options ?? [],
  ...(recommend !== undefined ? { recommend } : {}),
  ...(worklog !== undefined ? { worklog } : {}),
});

export const foldDecisions = (path: string, text: string): DecisionFold => {
  const items = new Map<string, Decision>();
  const problems: string[] = [];
  const warnings: string[] = [];
  const ignored = new Map<string, string>();
  const resolvedBy = new Map<string, string>();
  const boundBy = new Map<string, string>();
  // One open decision per message, so a reply binds to exactly one question. Two writers can both see a message free
  // and append; the first binding in the record holds it until that decision is resolved.
  const holder = (message: string, id: string) =>
    [...items.values()].find((d) => d.id !== id && settled(d) === undefined && d.message === message);
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const where = `${path}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (!isTorn(line)) problems.push(`${where}: ${error.message}`);
      continue;
    }
    try {
      const event = parseEvent(value);
      const ignore = (reason: string, writerReason = reason) => {
        warnings.push(`${where}: ${reason}`);
        ignored.set(event.n, writerReason);
      };
      const item = items.get(event.id);
      if (event.op === "ask") {
        if (item) throw new DecisionError(`decision ${event.id} was already asked`);
        const { message } = event;
        const other = message === undefined ? undefined : holder(message, event.id);
        items.set(event.id, { ...asked(event), ...(message !== undefined && !other ? { message } : {}) });
        if (message !== undefined && !other) boundBy.set(event.id, event.n);
        if (other) {
          const bound = `message ${message} is already bound to open decision ${other.id}`;
          ignore(
            `${bound}; decision ${event.id} recorded without it`,
            `${bound}; decision ${event.id} was recorded without the message: bind it with decision posted once the message is free`,
          );
        }
        continue;
      }
      if (!item) throw new DecisionError(`decision ${event.id} was never asked`);
      // Whether the lead may choose here never depends on another writer (kind, thread and options are fixed at the
      // ask), so a choice that breaks these is damage, even after the decision was settled, never a lost race.
      if (event.op === "choose") {
        if (item.kind !== "routine")
          throw new DecisionError(`decision ${event.id} is the owner's to answer; the lead chooses only a routine one`);
        if (event.thread !== item.thread)
          throw new DecisionError(
            `decision ${event.id} belongs to thread ${item.thread ?? "-"}; a choice recorded for ${event.thread} is not its`,
          );
        if (event.option > item.options.length)
          throw new DecisionError(`decision ${event.id} has no option ${event.option}`);
      }
      // Two writers can both see the decision open and append. The first answer, choice or withdrawal wins; anything
      // after it is the same race's normal result, ignored and named.
      const state = settled(item);
      if (state !== undefined) {
        ignore(`decision ${event.id} was already ${state}; ${event.op} ignored`);
        continue;
      }
      if (event.op === "posted") {
        const other = holder(event.message, event.id);
        if (other) {
          ignore(`message ${event.message} is already bound to open decision ${other.id}; posted ignored`);
          continue;
        }
        items.set(event.id, { ...item, message: event.message });
        boundBy.set(event.id, event.n);
        continue;
      }
      if (event.op === "withdraw") items.set(event.id, { ...item, withdrawnAt: event.at, reason: event.reason });
      else if (event.op === "choose") {
        const { at, option, source, reason } = event;
        items.set(event.id, {
          ...item,
          answeredAt: at,
          // In range: checked above against these options.
          answer: item.options[option - 1]!,
          option,
          answerSource: source,
          authority: "lead",
          reason,
        });
      } else {
        if (event.option !== undefined && event.option > item.options.length)
          throw new DecisionError(`decision ${event.id} has no option ${event.option}`);
        const { at, answer, source, option } = event;
        items.set(event.id, {
          ...item,
          answeredAt: at,
          answer,
          ...(option !== undefined ? { option } : {}),
          answerSource: source,
          authority: "owner",
        });
      }
      resolvedBy.set(event.id, event.n);
    } catch (error) {
      if (!(error instanceof DecisionError)) throw error;
      problems.push(`${where}: ${error.message}`);
    }
  }
  return { read: { items: [...items.values()], problems, warnings }, ignored, resolvedBy, boundBy };
};

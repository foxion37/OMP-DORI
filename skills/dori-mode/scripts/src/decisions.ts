import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

import { type DecisionFold, foldDecisions } from "./decisions-fold.ts";
import {
  type Decision,
  type DecisionAsk,
  type DecisionChoice,
  DecisionError,
  type DecisionRead,
  type Event,
  inRange,
  MAX_OPTIONS,
  parseEvent,
  settled,
} from "./decisions-record.ts";
import { Worklog } from "./worklog.ts";

const hex8 = () => randomBytes(4).toString("hex");

/** The id, time and a fresh nonce every event carries; the nonce lets a writer find its own event in the readback. */
const stamp = (id: string, now: number) => ({ id, at: new Date(now).toISOString(), n: hex8() });

/** Where a test puts another writer's record: after this writer's checks, or after its append and before its readback. */
type RaceSeam = { readonly beforeAppend?: () => void; readonly beforeReadback?: () => void };

/**
 * The product choices the lead put to the owner and is waiting on. decisions.jsonl is the record: one O_APPEND write
 * per change, so concurrent writers never lose each other's lines, and the lead re-posts the open list from it, not
 * from memory. The first answer, choice or withdrawal of a decision wins, and so does the first binding of a message.
 * Only the owner answers an `owner` decision; the lead may choose an option of a `routine` one. Nothing here grants a
 * permission: a native execution approval is answered only at its own prompt.
 */
export class Decisions {
  readonly path: string;

  constructor(
    readonly stateDir: string,
    private readonly race: RaceSeam = {},
  ) {
    this.path = join(stateDir, "decisions.jsonl");
  }

  read(): DecisionRead {
    return this.fold().read;
  }

  ask(input: DecisionAsk, now: number): Decision {
    const options = (input.options ?? []).map((o) => o.trim());
    if (options.length > MAX_OPTIONS) throw new DecisionError(`at most ${MAX_OPTIONS} options`);
    if (input.worklog !== undefined && !new Worklog(this.stateDir).open().some((item) => item.id === input.worklog))
      throw new DecisionError(`no open worklog item ${input.worklog}`);
    const message = input.message?.trim();
    if (message !== undefined) this.unbound(message);
    const known = new Set(this.read().items.map((d) => d.id));
    let id = hex8();
    while (known.has(id)) id = hex8();
    const lane = input.lane?.trim();
    const thread = input.thread?.trim();
    return this.write({
      op: "ask",
      ...stamp(id, now),
      question: input.question.trim(),
      source: input.source.trim(),
      ...(lane !== undefined ? { lane } : {}),
      ...(thread !== undefined ? { thread } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(options.length ? { options } : {}),
      ...(input.recommend !== undefined ? { recommend: input.recommend } : {}),
      ...(input.worklog !== undefined ? { worklog: input.worklog } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }

  posted(id: string, message: string, now: number): Decision {
    this.openDecision(id);
    this.unbound(message.trim(), id);
    return this.write({ op: "posted", ...stamp(id, now), message: message.trim() });
  }

  /**
   * The owner's answer, from the owner's own message, for a decision of either kind. A bare number names an option;
   * any other text is free text. A number outside the options is refused, never guessed.
   */
  answer(id: string, text: string, source: string, now: number): Decision {
    const decision = this.openDecision(id);
    const answer = text.trim();
    const count = decision.options.length;
    const option = count && /^\d+$/.test(answer) ? Number(answer) : undefined;
    if (option !== undefined && !inRange(option, count))
      throw new DecisionError(`decision ${id} has options 1 to ${count}; ${answer} is not one`);
    return this.write({
      op: "answer",
      ...stamp(id, now),
      answer,
      source: source.trim(),
      ...(option !== undefined ? { option } : {}),
    });
  }

  /**
   * Records one numbered routine choice, its reason, and a caller-supplied source reference in the decision's thread.
   * This does not verify message delivery. An owner decision, invalid option, or different thread is refused without
   * writing. A recorded choice settles the question, never a permission.
   */
  choose(id: string, option: string, choice: DecisionChoice, now: number): Decision {
    const decision = this.openDecision(id);
    if (decision.kind !== "routine")
      throw new DecisionError(`decision ${id} is the owner's to answer; the lead chooses only a routine one`);
    const picked = option.trim();
    const count = decision.options.length;
    const number = /^\d+$/.test(picked) ? Number(picked) : undefined;
    if (number === undefined || !inRange(number, count))
      throw new DecisionError(`decision ${id} takes the lead's choice of option 1 to ${count}; ${picked} is not one`);
    const thread = choice.thread.trim();
    if (thread !== decision.thread)
      throw new DecisionError(`decision ${id} belongs to thread ${decision.thread ?? "-"}, not ${thread}`);
    return this.write({
      op: "choose",
      ...stamp(id, now),
      option: number,
      reason: choice.reason.trim(),
      source: choice.source.trim(),
      thread,
    });
  }

  withdraw(id: string, reason: string, now: number): Decision {
    this.openDecision(id);
    return this.write({ op: "withdraw", ...stamp(id, now), reason: reason.trim() });
  }

  private fold(): DecisionFold {
    return foldDecisions(this.path, existsSync(this.path) ? readFileSync(this.path, "utf8") : "");
  }

  // A check for a friendly refusal; the fold settles writers that both pass it.
  private unbound(message: string, except?: string): void {
    const other = this.read().items.find((d) => d.id !== except && settled(d) === undefined && d.message === message);
    if (other) throw new DecisionError(`message ${message} is already bound to open decision ${other.id}`);
  }

  private openDecision(id: string): Decision {
    const decision = this.read().items.find((d) => d.id === id);
    if (!decision) throw new DecisionError(`decision not found: ${id}`);
    const state = settled(decision);
    if (state === "answered") throw new DecisionError(`decision ${id} is answered: ${decision.answer ?? ""}`);
    if (state === "withdrawn") throw new DecisionError(`decision ${id} is withdrawn: ${decision.reason ?? ""}`);
    return decision;
  }

  private write(event: Event): Decision {
    parseEvent(event);
    mkdirSync(this.stateDir, { recursive: true });
    this.race.beforeAppend?.();
    const fd = openSync(this.path, "a+", 0o600);
    try {
      // A writer that stopped mid-record left no newline: start on a fresh line so only the torn line is damaged.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
    this.race.beforeReadback?.();
    // Another writer's event can match ours field for field (same millisecond, same text); only the nonce is ours.
    const { read, ignored, resolvedBy, boundBy } = this.fold();
    const item = read.items.find((d) => d.id === event.id);
    if (!item) throw new DecisionError(`decision ${event.id} did not read back`);
    const reason = ignored.get(event.n);
    if (reason !== undefined) throw new DecisionError(reason);
    if (event.op !== "ask" && event.op !== "posted" && resolvedBy.get(event.id) !== event.n)
      throw new DecisionError(`decision ${event.id} did not read back as resolved by this ${event.op}`);
    if (event.op === "posted" && boundBy.get(event.id) !== event.n)
      throw new DecisionError(`decision ${event.id} posted ${event.message} was replaced by a later posted`);
    return item;
  }
}

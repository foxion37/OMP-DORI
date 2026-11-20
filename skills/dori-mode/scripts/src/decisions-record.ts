/** The decisions.jsonl record format: one event per line, each validated alone and then folded in order. */

/**
 * Who may settle a decision. `owner` (every question recorded without a kind reads as one): only the owner's answer
 * does. `routine`: a reversible choice inside the work's original scope, between at least two numbered options, in the
 * thread of that work; the lead may also choose one of those options with a reason. Cost, permissions, outside
 * commitments, irreversible work, a change of scope or goal, and open questions stay `owner`. Neither kind is a
 * permission grant: a native execution approval is answered only at its own prompt, never by this record.
 */
export type DecisionKind = "owner" | "routine";
export const DECISION_KINDS: readonly DecisionKind[] = ["owner", "routine"];
/** A routine choice is a pick between options the question already named, so it needs at least two of them. */
const ROUTINE_MIN_OPTIONS = 2;

export type Decision = {
  readonly id: string;
  readonly question: string;
  readonly source: string;
  readonly askedAt: string;
  readonly lane?: string;
  readonly thread?: string;
  readonly kind: DecisionKind;
  /** Numbered 1..n in this order; an answer names an option by its number. */
  readonly options: readonly string[];
  readonly recommend?: number;
  readonly worklog?: string;
  /** Where the question was posted; a reply to exactly this message is the owner's answer. */
  readonly message?: string;
  readonly answeredAt?: string;
  readonly answer?: string;
  readonly option?: number;
  /** The owner's reply, or for the lead's choice the message that told the decision's thread. */
  readonly answerSource?: string;
  /** Who settled the answer: the owner's reply, or the lead's choice of a routine decision's option. */
  readonly authority?: "owner" | "lead";
  readonly withdrawnAt?: string;
  /** Why it was withdrawn, or why the lead chose that option. */
  readonly reason?: string;
};
export type DecisionAsk = {
  readonly question: string;
  readonly source: string;
  readonly lane?: string;
  readonly thread?: string;
  readonly kind?: DecisionKind;
  readonly options?: readonly string[];
  readonly recommend?: number;
  readonly worklog?: string;
  readonly message?: string;
};
/** The lead's choice of a routine decision's option: its reason, the message that told the thread, and that thread. */
export type DecisionChoice = { readonly reason: string; readonly source: string; readonly thread: string };
/** `n` is the writing event's own random nonce: a writer finds its own event in the readback by it, never by content. */
type Stamp = { readonly id: string; readonly at: string; readonly n: string };
export type Event =
  | (Stamp & { readonly op: "ask" } & DecisionAsk)
  | (Stamp & { readonly op: "posted"; readonly message: string })
  | (Stamp & { readonly op: "answer"; readonly answer: string; readonly source: string; readonly option?: number })
  | (Stamp & { readonly op: "choose"; readonly option: number } & DecisionChoice)
  | (Stamp & { readonly op: "withdraw"; readonly reason: string });
/** problems are damage; warnings are the normal results of racing writers that are still worth naming. */
export type DecisionRead = { readonly items: Decision[]; readonly problems: string[]; readonly warnings: string[] };
export class DecisionError extends Error {}

export const MAX_OPTIONS = 9;
const ID = /^[0-9a-f]{8}$/;
// C0 and C1 controls (C1 holds U+0085 NEL and the CSI \x9b), DEL, and the Unicode line and paragraph separators.
const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  // oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to reject or strip them
  !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const inRange = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

const SHAPES = {
  ask: { need: { question: 1000, source: 400 }, may: { lane: 200, thread: 400, worklog: 8, message: 400 } },
  posted: { need: { message: 400 }, may: {} },
  answer: { need: { answer: 1000, source: 400 }, may: {} },
  choose: { need: { reason: 1000, source: 400, thread: 400 }, may: {} },
  withdraw: { need: { reason: 1000 }, may: {} },
} as const satisfies Record<Event["op"], { need: Record<string, number>; may: Record<string, number> }>;
/** The fields that are not one line of text, each checked on its own below. */
const OTHERS: Readonly<Record<string, readonly string[]>> = {
  ask: ["kind", "options", "recommend"],
  answer: ["option"],
  choose: ["option"],
};

export const parseEvent = (value: unknown): Event => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DecisionError("decision record must be a JSON object");
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || !ID.test(record["id"]))
    throw new DecisionError('decision field "id" must be 8 lowercase hex digits');
  if (!isoTime(record["at"]))
    throw new DecisionError('decision field "at" must be an ISO time as toISOString writes it');
  if (typeof record["n"] !== "string" || !ID.test(record["n"]))
    throw new DecisionError('decision field "n" must be 8 lowercase hex digits');
  const op = record["op"];
  if (typeof op !== "string" || !Object.hasOwn(SHAPES, op))
    throw new DecisionError('decision field "op" must be ask, posted, answer, choose or withdraw');
  const shape: { need: Record<string, number>; may: Record<string, number> } = SHAPES[op as Event["op"]];
  const known = ["op", "id", "at", "n", ...Object.keys(shape.need), ...Object.keys(shape.may), ...(OTHERS[op] ?? [])];
  const unknown = Object.keys(record).find((name) => !known.includes(name));
  if (unknown !== undefined) throw new DecisionError(`unknown decision field "${unknown}"`);
  for (const [name, max] of Object.entries({ ...shape.need, ...shape.may })) {
    if ((name in shape.need || record[name] !== undefined) && !singleLine(record[name], max))
      throw new DecisionError(`decision field "${name}" must be one nonempty line of at most ${max} characters`);
  }
  // References are printed as space-separated fields (boot's DECIDE line) and compared exactly by `match`.
  for (const name of ["lane", "thread", "message"])
    if (typeof record[name] === "string" && /\s/.test(record[name]))
      throw new DecisionError(`decision field "${name}" must be one reference without spaces`);
  if (record["worklog"] !== undefined && !ID.test(String(record["worklog"])))
    throw new DecisionError('decision field "worklog" must be 8 lowercase hex digits');
  const options = record["options"];
  if (
    options !== undefined &&
    (!Array.isArray(options) || !inRange(options.length, MAX_OPTIONS) || !options.every((o) => singleLine(o, 200)))
  )
    throw new DecisionError(`decision field "options" must hold 1 to ${MAX_OPTIONS} nonempty lines of 200 characters`);
  const count = Array.isArray(options) ? options.length : 0;
  if (record["recommend"] !== undefined && !inRange(record["recommend"], count))
    throw new DecisionError(
      count ? `the recommendation must be an option number from 1 to ${count}` : "a recommendation needs options",
    );
  if (record["option"] !== undefined && !inRange(record["option"], MAX_OPTIONS))
    throw new DecisionError(`decision field "option" must be an option number from 1 to ${MAX_OPTIONS}`);
  if (op === "choose" && record["option"] === undefined)
    throw new DecisionError("the lead's choice must name an option number");
  const kind = record["kind"];
  if (kind !== undefined && !DECISION_KINDS.includes(kind as DecisionKind))
    throw new DecisionError(`decision field "kind" must be ${DECISION_KINDS.join(" or ")}`);
  // A routine decision is a pick between named options in a known thread; anything else stays the owner's.
  if (kind === "routine" && count < ROUTINE_MIN_OPTIONS)
    throw new DecisionError(
      `a routine decision needs at least ${ROUTINE_MIN_OPTIONS} options; an open question is the owner's`,
    );
  if (kind === "routine" && (record["thread"] === undefined || record["thread"] === "none"))
    throw new DecisionError("a routine decision needs the thread of the work it belongs to");
  return record as Event;
};

// Every record is JSON.stringify of an event built op first, so it starts with this.
const RECORD_START = '{"op":"';
/** A line that does not parse but begins like a record is a write cut off halfway: harmless, and skipped quietly. */
export const isTorn = (line: string): boolean => line.startsWith(RECORD_START) || RECORD_START.startsWith(line);

export const settled = (d: Decision): "answered" | "withdrawn" | undefined =>
  d.answeredAt !== undefined ? "answered" : d.withdrawnAt !== undefined ? "withdrawn" : undefined;

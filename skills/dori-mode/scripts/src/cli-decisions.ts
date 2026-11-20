/**
 * dori decision: the owner's pending product choices, kept in a record so the lead never re-asks from memory, and the
 * lead's own choices of routine ones. It only writes the record and prints JSON: it sends no message and answers no
 * native approval prompt.
 */
import { type Command, die } from "./cli-context.ts";
import { Decisions } from "./decisions.ts";
import {
  DECISION_KINDS,
  type Decision,
  DecisionError,
  type DecisionKind,
  type DecisionRead,
  settled,
} from "./decisions-record.ts";
import { decisionText } from "./decisions-render.ts";
import { DORI_VALUE_OPTIONS } from "./monitor-dori.ts";
import { realClock } from "./run.ts";
import { Worklog } from "./worklog.ts";

/** Decision errors are the user's input refused: one line, never a stack. */
export const decisionErrors = [DecisionError] as const;

const show = (decision: Decision) => console.log(JSON.stringify(decision));

/** Every reading command names the ledger's damage and race warnings on stderr, then works from the rest. */
const warned = (read: DecisionRead): DecisionRead => {
  for (const problem of [...read.problems, ...read.warnings]) console.error(`DECISION_WARNING ${problem}`);
  return read;
};

// The answer is already recorded; a note that cannot be written is named and never undoes it.
const noteWorklog = (stateDir: string, decision: Decision, now: number): void => {
  const id = decision.worklog;
  if (id === undefined) return;
  try {
    const worklog = new Worklog(stateDir);
    const verb = decision.authority === "lead" ? "chosen by the lead" : "answered";
    const note = `decision ${decision.id} ${verb}: ${decision.answer ?? ""}`;
    if (worklog.open().some((item) => item.id === id))
      worklog.note(id, note.length <= 1000 ? note : `decision ${decision.id} ${verb} (see decisions.jsonl)`, now);
  } catch (e) {
    console.error(`DECISION_WARNING worklog ${id} note not written: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const VALUE_FLAGS: Readonly<Record<string, true>> = {
  source: true,
  lane: true,
  thread: true,
  kind: true,
  option: true,
  recommend: true,
  worklog: true,
  message: true,
  reason: true,
};

/**
 * The CLI parses loosely: a value flag at the end becomes `true`, and one followed by another flag takes that flag as
 * its value (`--option --recommend 1`). A decision record must hold what was meant, so both are refused here; a value
 * that really starts with `--` is given as `--option=--text`. The walk follows the parser's own token boundaries: every
 * value option of the CLI (DORI_VALUE_OPTIONS mirrors cli.ts) takes the next token, even `--`, and only a `--` that
 * no option took ends the options.
 */
const checkValues = (rest: readonly string[]): void => {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") return;
    const name = arg.startsWith("--") && !arg.includes("=") ? arg.slice(2) : undefined;
    if (name === undefined || !Object.hasOwn(DORI_VALUE_OPTIONS, name)) continue;
    const value = rest[i + 1];
    if (Object.hasOwn(VALUE_FLAGS, name) && (value === undefined || value.startsWith("--")))
      die(`${arg} needs a value`);
    i++;
  }
};

const decision: Command = async ({ key, rest, positionals, values, opt, need, strings, deps, config }) => {
  checkValues(rest);
  const ledger = new Decisions(config.stateDir);
  const id = () => positionals[1] ?? die(`decision ${key} needs a decision id`);
  const now = realClock.now();
  switch (key) {
    case "ask": {
      const question = positionals.slice(1).join(" ").trim() || die("decision ask needs a question");
      const laneKey = opt("lane");
      const lane =
        laneKey === undefined
          ? undefined
          : ((await deps.registry.read(laneKey)) ?? die(`no registered lane "${laneKey}"`));
      // `launch` records a lane without a thread as "none".
      const laneThread = lane?.thread && lane.thread !== "none" ? lane.thread : undefined;
      const given = opt("thread");
      const thread = given === "none" ? undefined : given || laneThread;
      const kind = opt("kind");
      if (kind !== undefined && !DECISION_KINDS.includes(kind as DecisionKind))
        die(`--kind must be ${DECISION_KINDS.join(" or ")}`);
      if (kind === "routine" && laneThread !== undefined && thread !== laneThread)
        die(`routine decision belongs to the lane's thread ${laneThread}`);
      const recommend = opt("recommend");
      if (recommend !== undefined && !/^\d+$/.test(recommend)) die("--recommend must be an option number");
      const worklog = opt("worklog");
      const message = opt("message");
      show(
        ledger.ask(
          {
            question,
            source: need("source"),
            ...(lane !== undefined ? { lane: lane.key } : {}),
            ...(thread !== undefined ? { thread } : {}),
            ...(kind !== undefined ? { kind: kind as DecisionKind } : {}),
            options: strings("option"),
            ...(recommend !== undefined ? { recommend: Number(recommend) } : {}),
            ...(worklog !== undefined ? { worklog } : {}),
            ...(message !== undefined ? { message } : {}),
          },
          now,
        ),
      );
      return;
    }
    case "posted":
      show(ledger.posted(id(), need("message"), now));
      return;
    case "answer": {
      const answered = ledger.answer(
        id(),
        positionals.slice(2).join(" ").trim() || die("decision answer needs the answer"),
        need("source"),
        now,
      );
      noteWorklog(config.stateDir, answered, now);
      show(answered);
      return;
    }
    case "choose": {
      // The lead's pick of a routine decision's option, recorded only after the choice and its reason were posted in
      // the decision's thread: --source is that message, --thread that thread.
      const decisionId = id();
      const [option, ...extra] = positionals.slice(2);
      const picked =
        option !== undefined && extra.length === 0 ? option : die("decision choose needs exactly one option number");
      const reasons = strings("reason");
      const [reason] = reasons;
      if (reasons.length !== 1 || reason === undefined) return die("decision choose needs exactly one --reason");
      const chosen = ledger.choose(decisionId, picked, { reason, source: need("source"), thread: need("thread") }, now);
      noteWorklog(config.stateDir, chosen, now);
      show(chosen);
      return;
    }
    case "withdraw": {
      const reasons = strings("reason");
      const [reason] = reasons;
      if (reasons.length !== 1 || reason === undefined) die("decision withdraw needs exactly one --reason");
      show(ledger.withdraw(id(), reason ?? "", now));
      return;
    }
    case "match": {
      const message = positionals[1] ?? die("decision match needs a message ref");
      // The fold lets one open decision hold a message, so the first open one found is the only one.
      const found = warned(ledger.read()).items.find((d) => settled(d) === undefined && d.message === message);
      if (found === undefined) process.exit(1);
      show(found);
      return;
    }
    case "list": {
      const read = warned(ledger.read());
      const open = read.items.filter((d) => settled(d) === undefined);
      console.log(JSON.stringify(values["open"] ? open : read.items, null, 2));
      return;
    }
    case "digest":
      for (const d of warned(ledger.read()).items) if (settled(d) === undefined) console.log(decisionText(d, now));
      return;
    default:
      die("decision needs ask, posted, answer, choose, withdraw, match, list or digest");
  }
};

export const decisionCommands: Readonly<Record<string, Command>> = { decision };

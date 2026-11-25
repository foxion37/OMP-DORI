import { Refusal } from "./refusal.ts";

export const USAGE = `cataly harness - a proactive multi-session harness using native OMP (headless by default)

  cataly harness up [--cwd DIR] [--fresh]               open lead, duty, duty loop and hourly loop sessions
                                                      the lead resumes its cleanly stopped session unless --fresh
  cataly harness stop                                   gracefully stop only the owned native harness; busy and blocked agents hold
                                                      terminal roles are never stopped; retire only proven-gone registrations
  cataly harness observe <role|lane|headless:UUID>        show native session identity, recent output and pending dialog IDs (JSON)
  cataly harness answer <role|lane|headless:UUID> --session ID --request ID --text JSON
                                                      explicitly answer one pending native dialog (e.g. {"value":"Deny"})
  cataly harness role <lead|duty> [REF]                 register a Tern session (tern:42) as lead or duty (default: this one)
  cataly harness start <key> --brief FILE [--cwd DIR]   open an OMP lane with the brief and lane rules
                          [--priority 1-9]            its turn for a lock (1 first, 9 last; default 5)
  cataly harness priority <key> <1-9>                   set an open lane's priority
  cataly harness report <key> --text T [--status working|waiting [--for TARGET]] [--evidence FILE|LINK ...]
                                                      only new evidence (a file changed since the last progress, a link
                                                      not reported before) resets the nudge and escalation clock; a
                                                      waiting lane stays on it, named with what it waits on
                                                      TARGET: job:ID, approval:ID, ci:owner/repo#N[@CHECK_RUN_ID];
                                                      other text is an unverified label, not a pending-operation proof
  cataly harness ready <key> --text T --evidence LINK [--evidence LINK ...]
  cataly harness send <lead|duty|key|ref> --text T      deliver now, or queue until the session's agent is idle
                          [--to-shell]                operator only: type this one message into a Tern block with no agent
  cataly harness inbox list <ref|role|key>              queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  cataly harness inbox ack <ref|role|key> <index>       drop a held entry: it did reach the session
  cataly harness inbox resend <ref|role|key> <index>    release a held entry: the next flush delivers it
  cataly harness duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  cataly harness duty stop [--text WHY] | resume | status   kill switch
  cataly harness loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                                      hourly: sync backlog, audit missed work, start the next item, ask decisions
  cataly harness loop stop [--text WHY] | resume | status   kill switch and last run
  cataly harness backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  cataly harness backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  cataly harness backlog import <owner/repo> [--label cataly] [--cwd DIR]   open labelled issues -> items
  cataly harness review <owner/repo#N> [--model M]      fresh OMP reviewer at the exact head -> receipt
  cataly harness merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  cataly harness done <key>                             lead closes a READY lane
  cataly harness lock <name> --lane K [--priority 1-9] -- CMD [ARG ...]
                                                      wait in line for lock <name> (lowest priority number first, then
                                                      first come), run CMD holding it, exit with CMD's code
  cataly harness lock <name> --list                     the lock's holder and its queue, one line
  cataly harness owner init | show | snapshot | check   opt-in owner profile ($CATALY_HOME/owner.md) at the end of the
                                                      lead's prompt: create it, print what the lead reads, keep
                                                      today's copy, validate it (OWNER_OK or OWNER_PROBLEM, exit 1)
  cataly harness owner diff [DATE] | revert DATE        compare with or restore a dated snapshot in owner-history/
  cataly harness status

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then cataly harness inbox ack or cataly harness inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.
A headless ref may be shortened, as status shows it, to a unique prefix of 8 or more characters (headless:3f2a9c1d);
an ambiguous or unknown prefix is refused.`;

/** `rest`: every argument after a bare `--` in flag position, verbatim (the command `lock` runs). */
export type Args = { pos: string[]; flags: Map<string, string[]>; rest: string[] };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["once", "force", "dry-run", "to-shell", "help", "list", "fresh"]);

export function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return { pos, flags, rest: argv.slice(i + 1) };
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    // A value flag at the very end (--text $MSG with MSG unset) has no value; reading it as "true" would send that word.
    const value = BOOLEAN_FLAGS.has(name) ? "true" : argv[++i];
    if (value === undefined) throw new Refusal(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags, rest: [] };
}

export const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
export const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

export async function textOf(a: Args): Promise<string> {
  const given = one(a, "text");
  if (given === undefined && process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  const text = given ?? (await Bun.stdin.text()).trim();
  // An unset variable (--text "$MSG") or an empty pipe would type a blank message into the pane and print DELIVERED.
  if (!text.trim()) throw new Refusal("the message is empty: give --text or pipe the message on stdin");
  return text;
}

import { Refusal } from "./refusal.ts";

export const USAGE = `dori harness - a proactive multi-session harness on herdr or hc + OMP

  dori harness up [--cwd DIR]                         open lead, duty, duty loop and hourly loop sessions
  dori harness role <lead|duty> [REF]                 register a session (w1:p3, herdr:w1:p3, hc:t7) as lead or duty (default: this one)
  dori harness start <key> --brief FILE [--cwd DIR]   open a lane: new tab, OMP session, brief + lane rules
  dori harness report <key> --text T [--status working|waiting [--for TARGET]] [--evidence FILE|LINK ...]
                                                      only new evidence (a file changed since the last progress, a link
                                                      not reported before) resets the nudge and escalation clock; a
                                                      waiting lane stays on it, named with what it waits on
  dori harness ready <key> --text T --evidence LINK [--evidence LINK ...]
  dori harness send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                          [--to-shell]                operator only: type this one message into a pane with no agent
  dori harness inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  dori harness inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  dori harness inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  dori harness duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  dori harness duty stop [--text WHY] | resume | status   kill switch
  dori harness loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                                      hourly: sync backlog, audit missed work, start the next item, ask decisions
  dori harness loop stop [--text WHY] | resume | status   kill switch and last run
  dori harness backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  dori harness backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  dori harness backlog import <owner/repo> [--label dori] [--cwd DIR]   open labelled issues -> items
  dori harness review <owner/repo#N> [--model M]      fresh OMP reviewer at the exact head -> receipt
  dori harness merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  dori harness done <key>                             lead closes a READY lane
  dori harness migrate [--to hc|herdr] (--lane K | --role lead|duty|duty-loop|hourly-loop | --all) [--dry-run]
                       [--wait-minutes N] [--resume]  hand sessions over to another runtime; MIGRATED, SKIP, DEFERRED,
                                                      or MIGRATE_ROLLBACK (exit 3) per session
  dori harness status

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then dori harness inbox ack or dori harness inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.`;

export type Args = { pos: string[]; flags: Map<string, string[]> };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["once", "force", "dry-run", "to-shell", "all", "resume", "help"]);

export function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
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
  return { pos, flags };
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

// What a cataly command line's own words are, as cli.ts parses it: the command right after the program and, after a
// messenger command, the platform, its first positional. test/boot-monitor-words.test.ts keeps both tables in step
// with cli.ts.

/** Every `cataly` command: cli.ts's own and its command tables. */
export const CATALY_COMMANDS: Record<string, true> = {
  adopt: true,
  artifact: true,
  artifacts: true,
  board: true,
  boot: true,
  "can-launch": true,
  channel: true,
  checkpoint: true,
  checkpoints: true,
  "claim-done": true,
  close: true,
  "dead-panes": true,
  decision: true,
  doctor: true,
  eta: true,
  "monitor-presets": true,
  freshness: true,
  guard: true,
  harness: true,
  headless: true,
  heavy: true,
  holds: true,
  "idle-check": true,
  inbound: true,
  "inbound-abandon": true,
  "inbound-lag": true,
  lanes: true,
  launch: true,
  lead: true,
  lesson: true,
  "object-done": true,
  park: true,
  pause: true,
  policy: true,
  pr: true,
  presence: true,
  queue: true,
  quota: true,
  react: true,
  recall: true,
  relayed: true,
  remote: true,
  reopen: true,
  report: true,
  resume: true,
  schedule: true,
  scheduler: true,
  send: true,
  status: true,
  sync: true,
  tell: true,
  thread: true,
  transcribe: true,
  update: true,
  upstream: true,
  usage: true,
  "verify-pr": true,
  voice: true,
  watch: true,
  worklog: true,
};
/** cli.ts's options that take a value (`type: "string"`); the others are flags. */
export const CATALY_VALUE_OPTIONS: Record<string, true> = {
  title: true,
  brief: true,
  template: true,
  set: true,
  after: true,
  "expires-hours": true,
  done: true,
  thread: true,
  request: true,
  model: true,
  runtime: true,
  cwd: true,
  pane: true,
  evidence: true,
  reason: true,
  root: true,
  resolve: true,
  note: true,
  repo: true,
  "resume-when": true,
  loop: true,
  "activity-file": true,
  purpose: true,
  to: true,
  text: true,
  edit: true,
  "text-file": true,
  reply: true,
  tag: true,
  message: true,
  emoji: true,
  kind: true,
  owner: true,
  report: true,
  delivery: true,
  for: true,
  step: true,
  result: true,
  "remote-effect": true,
  "evidence-file": true,
  artifact: true,
  sha256: true,
  receipt: true,
  "wall-minutes": true,
  "token-limit": true,
  "cost-limit": true,
  "activity-path": true,
  rule: true,
  outcome: true,
  lesson: true,
  source: true,
  limit: true,
  option: true,
  recommend: true,
  lane: true,
  worklog: true,
  "ignore-author": true,
  self: true,
  "timeout-seconds": true,
  "every-seconds": true,
  "on-success": true,
  at: true,
  cron: true,
  tz: true,
  deliver: true,
  systemd: true,
};
const MESSENGER_COMMANDS: Record<string, true> = {
  send: true,
  presence: true,
  inbound: true,
  "inbound-abandon": true,
  thread: true,
  react: true,
  channel: true,
  voice: true,
};
const PLATFORMS: Record<string, true> = { slack: true, telegram: true, discord: true };

/** The indices of a cataly program's own words: itself, its command and, after a messenger command, the platform. */
export const catalyOwnWords = (words: readonly string[], program: number): number[] => {
  const command = words[program + 1] ?? "";
  if (CATALY_COMMANDS[command] !== true) return [program];
  const own = [program, program + 1];
  if (MESSENGER_COMMANDS[command] !== true) return own;
  for (let at = program + 2; at < words.length; at++) {
    const word = words[at] ?? "";
    // An option's value is never the platform (`--text slack`); after `--` every word is a positional.
    if (word === "--") at++;
    else if (word.startsWith("--")) {
      if (!word.includes("=") && CATALY_VALUE_OPTIONS[word.slice(2)] === true) at++;
      continue;
    } else if (word.startsWith("-") && word !== "-") continue;
    if (PLATFORMS[words[at] ?? ""] === true) own.push(at);
    return own;
  }
  return own;
};

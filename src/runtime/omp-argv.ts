// What a configured argv runs: OMP's launch forms behind the prefixes Dori reads. Process lines are omp.ts's.
import { platform } from "../platform/index.ts";
import { OMP_EXECUTABLE, sourceOmpArgv } from "./omp.ts";
import { ASSIGNMENT, envCommandAt, LAUNCHERS, launcherCommandAt, RUNNER, RUNNERS, SHELLS } from "./omp-prefixes.ts";
// A word naming OMP's executable or published entry (the change-before detector's words), or the source launcher's
// preload as a whole word: prose that mentions the path is not one.
const OMP_WORD =
  /(?:^|[/\\])omp(?:\s|$)|pi-coding-agent[/\\]dist[/\\]cli\.js|^\S*\/packages\/coding-agent\/scripts\/omp\.ts$/;
// The command string of a shell (`sh -c`), `env -S` or a package runner (`npx -c`, `--call=`) is not parsed: shell
// quoting, expansion and redirection can run OMP in too many ways. One that mentions an omp token anywhere is
// unreadable, so an update agent must declare `engine` for it; a false match only asks for that declaration. Only those
// programs' (or a launcher's) script options are read so; another agent's `-c` is its own setting.
const OMP_TOKEN = /(?:^|[^\w.-])omp(?:[^\w.-]|$)|pi-coding-agent[/\\]dist[/\\]cli\.js|coding-agent\/scripts\/omp\.ts/;
const SCRIPT_OPTION = /^(?:-[A-Za-z]*c[A-Za-z]*|-S|--split-string|--call)$/;
const SCRIPT_PROGRAMS = new Set([...SHELLS, ...Object.keys(LAUNCHERS), ...RUNNERS, "env", "bun"]);
// OMP's own executable or published entry, also as Windows spells it (`C:\bin\omp.exe`, `\dist\cli.js`).
const isOmpExecutable = (word: string): boolean =>
  OMP_EXECUTABLE.test(word) ||
  (platform.windowsExecutableNames &&
    (platform.programName(word) === "omp" || /@oh-my-pi[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/i.test(word)));
// `words` start at a program (assignments aside): only that program's script option is read as a script.
const names = (words: readonly string[]): boolean => {
  const program = words.find((word) => !ASSIGNMENT.test(word)) ?? "";
  const scripted = SCRIPT_PROGRAMS.has(platform.programName(program));
  return words.some((word, at) => {
    if (OMP_WORD.test(word)) return true;
    if (!scripted) return false;
    const attached = /^(?:--call|--split-string|-[cS])=(.*)$/s.exec(word)?.[1];
    return OMP_TOKEN.test(attached ?? (SCRIPT_OPTION.test(words[at - 1] ?? "") ? word : ""));
  });
};
// OMP's package, by name or alias (`npm:@oh-my-pi/pi-coding-agent@1`, `x@npm:…`): its only bin is omp. A package
// manager form Dori does not read exactly (`npm --silent exec`, `pnpm dlx`, an alias) that names it is unreadable.
const OMP_PACKAGE_MENTION = /(?:^|[\s:=])@oh-my-pi\/pi-coding-agent(?:@|\s|$)/;
const runsOmpPackage = (argv: readonly string[]): boolean =>
  argv.some((_, at) => isRunner(argv, at)) && argv.some((word) => OMP_PACKAGE_MENTION.test(word));
// A package manager word, or Bun with its `x` subcommand later in the argv.
const isRunner = (argv: readonly string[], at: number): boolean => {
  const name = platform.programName(argv[at] ?? "");
  return RUNNERS.includes(name) || (name === "bun" && argv.slice(at + 1).includes("x"));
};

/**
 * What an exact argv runs, after leading `NAME=value` assignments and the `env` utility with its options: the command
 * itself (that prefix removed), as `omp` when it starts OMP and `other` otherwise, or `unparsed` when a command prefix
 * cannot be read unambiguously, which must not be taken for either.
 */
export type OmpArgv =
  { readonly kind: "omp" | "other"; readonly command: readonly string[] } | { readonly kind: "unparsed" };

/**
 * Where the command starts once each readable prefix is removed in turn (`env -i env -u X nice timeout 600 omp` reads
 * like `omp`): `stuck` names the prefix word whose options could not be read, which then starts the command.
 */
function prefixEnd(argv: readonly string[]): {
  at: number;
  launched: boolean;
  runner?: true;
  stuck?: string;
  forking: string | undefined;
} {
  let at = 0;
  let launched = false;
  let forking: string | undefined;
  for (;;) {
    while (ASSIGNMENT.test(argv[at] ?? "")) at++;
    const word = platform.programName(argv[at] ?? "");
    const subcommand = argv[at + 1];
    // Bun's command word can be `x`; an `x` after a script is that script's data, not a package runner.
    const bunCommand = word === "bun" ? argv.slice(at + 1).find((arg) => !arg.startsWith("-")) : undefined;
    if (LAUNCHERS[word]?.forks || RUNNERS.includes(word) || bunCommand === "x") forking ??= word;
    let next: number | undefined;
    let runner = false;
    if (word === "env") next = envCommandAt(argv, at + 1);
    else if (Object.hasOwn(LAUNCHERS, word)) next = launcherCommandAt(argv, at + 1, LAUNCHERS[word]!);
    else if (word === "bunx" || word === "npx") [next, runner] = [launcherCommandAt(argv, at + 1, RUNNER), true];
    else if (
      (word === "bun" && subcommand === "x") ||
      (word === "npm" && (subcommand === "exec" || subcommand === "x"))
    ) {
      [next, runner] = [launcherCommandAt(argv, at + 2, RUNNER), true];
      // npm parses even trailing options unless its command immediately follows `--`; inserted OMP guards would vanish.
      if (word === "npm" && next !== undefined && argv[next - 1] !== "--") next = undefined;
    } else if (word === "omp-dori" && subcommand === "omp") {
      // The side wrapper's `omp` subcommand runs this home's OMP with the arguments that follow.
      next = at + 1;
    } else return { at, launched, forking };
    if (next === undefined) return { at, launched, stuck: word, forking };
    at = next;
    launched ||= word !== "env";
    if (word === "omp-dori") return { at, launched, forking };
    // A runner's package spec names the package whose bin it runs: OMP's package runs OMP (its only bin).
    if (runner && OMP_PACKAGE.test(argv[at] ?? "")) return { at, launched, runner: true, forking };
  }
}
const OMP_PACKAGE = /^@oh-my-pi\/pi-coding-agent(?:@\S+)?$/;

export function classifyOmpArgv(argv: readonly string[]): OmpArgv {
  const { at, launched, runner, stuck } = prefixEnd(argv);
  if (runner) return { kind: "omp", command: argv.slice(at) };
  // An unreadable launcher prefix matters only when it may run OMP; any other command keeps its own contract.
  if (stuck !== undefined) {
    return stuck === "env" || names(argv.slice(at)) || assignsOmp(argv, at) || runsOmpPackage(argv)
      ? { kind: "unparsed" }
      : { kind: "other", command: argv.slice(at) };
  }
  const command = argv.slice(at);
  const classified = classifyCommand(command);
  // A launcher option Dori misread (`timeout --unknown 5 600 omp`) leaves a command that only names OMP: refuse it
  // rather than drop the guard. An external wrapper behind a launcher must declare its engine the same way, as must a
  // command handed OMP's path in a removed assignment (`env OMP_BIN=/x/omp sh -c 'exec "$OMP_BIN"'`).
  if (classified.kind !== "other") return classified;
  // A package manager running a command (`pnpm exec omp`) is read like a launcher Dori cannot fully parse.
  return ((launched || isRunner(command, 0)) && (names(command) || runsOmpPackage(argv))) || assignsOmp(argv, at)
    ? { kind: "unparsed" }
    : classified;
}

/** First known potentially forking prefix, including unreadable runner variants; classification is independent. */
export const nonPidPreservingPrefix = (argv: readonly string[]): string | undefined => prefixEnd(argv).forking;

/** Whether a `NAME=VALUE` word before `at` (a shell or `env` assignment) gives OMP's path, as the old detector read it. */
const assignsOmp = (argv: readonly string[], at: number): boolean =>
  argv
    .slice(0, at)
    .some((word) => /^[^-][^=]*=.*(?:[/\\]omp(?:\s|$)|pi-coding-agent[/\\]dist[/\\]cli\.js)/s.test(word));

/** What a command without assignment, env or launcher prefixes runs. */
function classifyCommand(command: readonly string[]): OmpArgv {
  if (sourceOmpArgv(command)) return { kind: "omp", command };
  const name = platform.programName(command[0] ?? "");
  if (isOmpExecutable(command[0] ?? "")) return { kind: "omp", command };
  // A shell runs a script Dori cannot read: one that names OMP must declare its engine.
  if (SHELLS.has(name)) return names(command) ? { kind: "unparsed" } : { kind: "other", command };
  if (name !== "bun" && name !== "node") return { kind: "other", command };
  let script = 1;
  while (command[script]?.startsWith("-")) script++;
  const prefix = name === "bun" && command[script] === "run" ? 2 : 1;
  if (prefix === 2) {
    script++;
    while (command[script]?.startsWith("-")) script++;
  }
  if (isOmpExecutable(command[script] ?? "")) return { kind: "omp", command };
  if (script > prefix && command.slice(script + 1).some((arg) => isOmpExecutable(arg))) return { kind: "unparsed" };
  return { kind: "other", command };
}

/** An exact argv that starts OMP (see classifyOmpArgv); an unparsed command prefix is not one. */
export const isOmpArgv = (argv: readonly string[]): boolean => classifyOmpArgv(argv).kind === "omp";

/**
 * Whether an argv may run OMP: what update refuses as possibly OMP is OMP for lanes too. It starts OMP, a word after
 * its readable prefixes names OMP the way the detector before exact classification read it (`/x/omp`, `omp …`, the
 * published CLI), a shell, `env -S` or runner script mentions an omp token, a package manager names OMP's package, or a
 * removed assignment gives OMP's path. Lane startup and pause then prove a goal only from OMP's trusted session record,
 * never by quoted screen text. A wrong match fails safe (STARTUP_NO_GOAL); another agent's own `-c` value or prose
 * outside a script stays a custom agent. Role flags and update guards need the exact start (isOmpArgv).
 */
export const mayRunOmpArgv = (argv: readonly string[]): boolean => {
  const { at, launched, stuck } = prefixEnd(argv);
  // Readable prefixes are removed first: `env TERM=x codex -c '…omp…'` is codex's own option.
  const command = argv.slice(at);
  return (
    isOmpArgv(argv) ||
    assignsOmp(argv, at) ||
    names(command) ||
    ((launched || stuck !== undefined || isRunner(command, 0)) && runsOmpPackage(argv))
  );
};

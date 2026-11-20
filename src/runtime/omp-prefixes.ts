// The prefixes Dori reads before a configured command. Parsing a launcher or package runner does not establish
// PID preservation; automated native updates separately refuse prefixes that may fork.
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// GNU env's long options: those that take a separate operand when written without `=`, and those that take none.
const ENV_LONG: Record<string, "flag" | "operand"> = {
  "ignore-environment": "flag",
  null: "flag",
  debug: "flag",
  "block-signal": "flag",
  "default-signal": "flag",
  "ignore-signal": "flag",
  "list-signal-handling": "flag",
  unset: "operand",
  chdir: "operand",
  argv0: "operand",
};

/** GNU getopt_long accepts any unambiguous prefix of a long option name. */
const envLong = (name: string): "flag" | "operand" | undefined => {
  if (Object.hasOwn(ENV_LONG, name)) return ENV_LONG[name];
  const matches = Object.keys(ENV_LONG).filter((option) => name !== "" && option.startsWith(name));
  return matches.length === 1 ? ENV_LONG[matches[0]!] : undefined;
};

/**
 * The index where `env [OPTION]... [-] [NAME=VALUE]... COMMAND` starts COMMAND, or undefined when an option is not one
 * of the GNU/BSD options that only change the environment or directory. `-S`/`--split-string` re-parses a string with
 * its own quoting, escapes and comments, so it is not decoded here.
 */
export function envCommandAt(argv: readonly string[], at: number): number | undefined {
  for (;;) {
    const word = argv[at];
    if (word === undefined || word === "-" || !word.startsWith("-")) break;
    at++;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const kind = envLong(word.slice(2, equals < 0 ? undefined : equals));
      if (kind === undefined) return undefined;
      if (kind === "operand" && equals < 0) at++;
      continue;
    }
    for (let i = 1; i < word.length; i++) {
      const flag = word[i];
      if (flag === "i" || flag === "0" || flag === "v") continue;
      if (flag !== "u" && flag !== "C" && flag !== "P" && flag !== "a") return undefined;
      if (i + 1 === word.length) at++;
      break;
    }
  }
  if (argv[at] === "-") at++;
  // env takes every word with a `=` as an assignment, not only shell-style names.
  while (argv[at]?.includes("=")) at++;
  return at < argv.length ? at : undefined;
}

// Launcher options and operands before the command (timeout's duration). Unknown options make a prefix unreadable:
// a misread value could otherwise be taken for the command. `forks` includes conditional forks, not only forced ones.
// Other programs (sudo, xargs, any script) are external commands.
type Launcher = {
  readonly values: readonly string[];
  readonly flags: readonly string[];
  readonly operands: number;
  readonly forks?: true;
};
export const LAUNCHERS: Record<string, Launcher> = {
  nohup: { values: [], flags: [], operands: 0 },
  nice: { values: ["-n", "--adjustment"], flags: [], operands: 0 },
  timeout: {
    values: ["-k", "--kill-after", "-s", "--signal"],
    flags: ["-v", "--verbose", "-p", "--preserve-status", "-f", "--foreground"],
    operands: 1,
    forks: true,
  },
  setsid: { values: [], flags: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"], operands: 0, forks: true },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], flags: [], operands: 0 },
  caffeinate: { values: ["-t", "-w"], flags: ["-d", "-i", "-m", "-s", "-u"], operands: 0, forks: true },
};
// Package managers that run a package's bin (any of their arguments may name OMP's package). `npx`, `bunx`, `bun x`
// and `npm exec`/`x` are read with RUNNER's options; `-c`/`--call` take a command string, which is not parsed.
export const RUNNERS = ["npx", "bunx", "npm", "pnpm", "pnpx", "yarn"];
export const RUNNER: Launcher = {
  values: ["-p", "--package", "--cache", "--userconfig", "--registry", "--prefix", "-w", "--workspace", "--cwd"],
  flags: [
    ...["-y", "--yes", "--no", "--no-install", "-q", "--quiet", "--offline", "--prefer-offline", "--prefer-online"],
    ...["--ignore-existing", "--bun", "--verbose", "--silent"],
  ],
  operands: 0,
};
export const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

/** The long option `word` names, exactly or by an unambiguous getopt_long prefix. */
const longOption = (word: string, options: readonly string[]): boolean =>
  options.includes(word) || options.filter((name) => name.startsWith("--") && name.startsWith(word)).length === 1;

/** The index of a launcher's command after its options and operands, or undefined when it cannot be read. */
export function launcherCommandAt(argv: readonly string[], at: number, launcher: Launcher): number | undefined {
  const { flags } = launcher;
  while (argv[at]?.startsWith("-") && argv[at] !== "-") {
    const word = argv[at++]!;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      if (equals >= 0 ? !longOption(word.slice(0, equals), launcher.values) : !longOption(word, flags)) {
        if (equals >= 0 || !longOption(word, launcher.values)) return undefined;
        at++;
      }
      continue;
    }
    if (launcher === LAUNCHERS["nice"] && /^-\d+$/.test(word)) continue;
    // A short cluster (`-vk 5`, `-it600`): flags, then at most one option whose value is attached or the next word.
    for (let i = 1; i < word.length; i++) {
      const short = `-${word[i]}`;
      if (flags.includes(short)) continue;
      if (!launcher.values.includes(short)) return undefined;
      if (i + 1 === word.length) at++;
      break;
    }
  }
  at += launcher.operands;
  return at < argv.length ? at : undefined;
}

// The launchers a watch's command may run its program behind (monitor-command.ts), read by their own option syntax.
// Read launcher options before the program; env's -S can supply both more env options and the program.

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
  "split-string": "operand",
};
/** GNU getopt_long accepts any unambiguous prefix of a long option name. */
const envLong = (name: string): string | undefined => {
  if (Object.hasOwn(ENV_LONG, name)) return name;
  const matches = Object.keys(ENV_LONG).filter((option) => name !== "" && option.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * What `env [OPTION]... [-] [NAME=VALUE]... COMMAND` runs: COMMAND from word `at` on, or with `-S STRING` the words of
 * STRING, which starts at character `split` of word `at`, then the words after it; and the directory `-C` gives it.
 * Undefined for an option it cannot read or no command.
 */
export type EnvCommand = { readonly at: number; readonly split?: number; readonly chdir: string | undefined };
export const envCommandAt = (words: readonly string[], at: number): EnvCommand | undefined => {
  let chdir: string | undefined;
  // STRING inline in word `at - 1` from `from`, or the whole next word.
  const split = (from: number, inline: boolean): EnvCommand | undefined =>
    inline ? { at: at - 1, split: from, chdir } : at < words.length ? { at, split: 0, chdir } : undefined;
  for (;;) {
    const word = words[at];
    if (word === undefined || word === "-" || !word.startsWith("-")) break;
    at++;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = envLong(word.slice(2, equals < 0 ? undefined : equals));
      if (name === undefined) return undefined;
      if (name === "split-string") return split(equals + 1, equals >= 0);
      if (name === "chdir") chdir = equals < 0 ? words[at] : word.slice(equals + 1);
      if (ENV_LONG[name] === "operand" && equals < 0) at++;
      continue;
    }
    for (let i = 1; i < word.length; i++) {
      const flag = word[i] ?? "";
      if (flag === "i" || flag === "0" || flag === "v") continue;
      if (!"uCPaS".includes(flag)) return undefined;
      const inline = i + 1 < word.length;
      if (flag === "S") return split(i + 1, inline);
      if (flag === "C") chdir = inline ? word.slice(i + 1) : words[at];
      if (!inline) at++;
      break;
    }
  }
  if (words[at] === "-") at++;
  while (words[at]?.includes("=")) at++;
  return at < words.length ? { at, chdir } : undefined;
};

// Launchers that run their command unchanged: the options that take a value and the operands before the command
// (timeout's duration). Their other options are flags.
type Launcher = { readonly values: readonly string[]; readonly operands: number };
export const LAUNCHERS: Record<string, Launcher> = {
  nohup: { values: [], operands: 0 },
  nice: { values: ["-n", "--adjustment"], operands: 0 },
  timeout: { values: ["-k", "--kill-after", "-s", "--signal"], operands: 1 },
  setsid: { values: [], operands: 0 },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], operands: 0 },
  caffeinate: { values: ["-t", "-w"], operands: 0 },
  // flock's operand is its lock file or descriptor; `flock LOCK -c CMD` runs a shell string (monitor-command.ts).
  flock: { values: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], operands: 1 },
  sudo: {
    values: [
      "-u",
      "-g",
      "-C",
      "-D",
      "-h",
      "-p",
      "-r",
      "-t",
      "-U",
      "-T",
      "--user",
      "--group",
      "--close-from",
      "--chdir",
      "--host",
      "--prompt",
      "--role",
      "--type",
      "--other-user",
      "--command-timeout",
    ],
    operands: 0,
  },
  ionice: { values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"], operands: 0 },
  time: { values: ["-o", "-f", "--output", "--format"], operands: 0 },
};

/** Where a launcher's command starts after its options and operands, or undefined when there is none. */
export const launcherCommandAt = (words: readonly string[], at: number, launcher: Launcher): number | undefined => {
  while (words[at]?.startsWith("-") && words[at] !== "-") {
    const word = words[at++] ?? "";
    if (word === "--") break;
    if (word.startsWith("--")) {
      // getopt_long accepts an unambiguous prefix of a long option (`--kill` for `--kill-after`).
      if (!word.includes("=") && launcher.values.some((value) => value.startsWith("--") && value.startsWith(word)))
        at++;
      continue;
    }
    // A bundle (`-vk 5`, `-oL`): a value option takes the rest of the word, or the next word when it ends the bundle.
    for (let i = 1; i < word.length; i++) {
      if (!launcher.values.includes(`-${word[i]}`)) continue;
      if (i + 1 === word.length) at++;
      break;
    }
  }
  at += launcher.operands;
  return at < words.length ? at : undefined;
};

// Bun's options that take a separate value; the others are flags.
const BUN_VALUES = ["--cwd", "--preload", "-r", "--require", "--import", "--config", "-c", "--env-file", "--define"];

/** `bun [OPTION]... [run] [OPTION]... ENTRY`: where ENTRY is and the directory `--cwd` runs it in. */
export const bunEntryAt = (words: readonly string[], at: number): { at: number; cwd?: string } | undefined => {
  let cwd: string | undefined;
  for (let run = false; at < words.length; at++) {
    const word = words[at] ?? "";
    if (word === "run" && !run) run = true;
    else if (word.startsWith("--cwd=")) cwd = word.slice("--cwd=".length);
    else if (BUN_VALUES.includes(word)) {
      if (word === "--cwd") cwd = words[at + 1];
      at++;
    } else if (!word.startsWith("-")) return { at, ...(cwd === undefined ? {} : { cwd }) };
  }
  return undefined;
};

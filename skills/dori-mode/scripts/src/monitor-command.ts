import { basename, isAbsolute, join } from "node:path";
import { doriOwnWords } from "./monitor-dori.ts";
import { bunEntryAt, envCommandAt, LAUNCHERS, launcherCommandAt } from "./monitor-launchers.ts";
import { quotedSubstitutions, shellWords, splitString, unquote } from "./monitor-syntax.ts";

// Which words of a watch's own command may name a lane. A command string is cut into commands at operators and line
// breaks outside quotes (monitor-syntax.ts), at a shell's or `flock LOCK -c`'s script, and at a command substitution
// inside double quotes. Each command's program is its first word after reserved words (`do`, `then`, `if`, `!`, ...
// only where the command starts), assignments, `exec`, `command` and `builtin`, and after a known launcher's own
// options and operands (monitor-launchers.ts: `env -u NAME`, `env -S STRING` runs STRING's words, `timeout -vk 5 60`,
// `sudo -u USER`, `flock LOCK`): it is never a lane (`env tail -F` is not lane `tail`). A dori program is `dori`,
// `omp-dori` or the skill's `dori-mode/scripts/src/cli.ts`, also behind bun's options (`bun --cwd DIR src/cli.ts`); a
// relative one is read in the directory it runs in: the watch's cwd, as a `cd` before it or `env -C`/`--chdir` for
// its own command leaves it, never another program's `-C`. Its command and, after a messenger command, the platform
// are its own words (monitor-dori.ts), an option's value never (`dori send --text slack discord`). Every other word may
// name a lane, as before: an argument (`dori checkpoints --cwd X dori`), a path (`ls /x/dori freshness`) or another
// program's word (`env rg -c dori freshness`). A legacy record's non-string argv word holds a program's place.
// A `cd` holds for the commands after it in its own subshell or command substitution only, and replaces the directory
// only where it surely runs in that shell; elsewhere it adds a possible one, and a relative entry must be the skill CLI
// in every possible directory (`false && cd SKILL; bun src/cli.ts` may run elsewhere).
// Known limits: a `#` comment is read as words; behind an `env` option this does not know, no program is read, so
// every word after it may name a lane as before.
const DORI_NAMES: Record<string, true> = { dori: true, "omp-dori": true };
// A POSIX path is cut at `/` only; a backslash is an ordinary name character there, so only Windows reads it as one.
const SKILL_SOURCE =
  process.platform === "win32"
    ? /(?:^|[\\/])dori-mode[\\/]scripts[\\/]src[\\/]cli\.ts$/
    : /(?:^|\/)dori-mode\/scripts\/src\/cli\.ts$/;
// A Set: a `then` key on an object literal reads as a thenable.
const RESERVED = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);
const PREFIXES: Record<string, true> = { exec: true, command: true, builtin: true };
const SHELLS: Record<string, true> = { sh: true, bash: true, dash: true, zsh: true, ksh: true, fish: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A word as passed on and the whitespace-split word of the line each of its characters is in; in a command string,
 * the operator before it where a new command starts at it, the subshells and substitutions it is in, its own words as a script, and its
 * quoted command substitutions.
 */
type Word = {
  readonly word: string;
  readonly baseAt: (at: number) => number;
  readonly after?: string | undefined;
  readonly scope?: readonly number[];
  readonly script?: () => readonly Word[];
  readonly substitutions?: () => readonly (readonly Word[])[];
};

/** Where a shell's `-c` script is, past long options, `o`/`O` operands and `--`/`-`; undefined without one. */
const scriptAt = (words: readonly string[], at: number): number | undefined => {
  let script = false;
  // Bash reads single-dash long names only before its first short option.
  let longAliases = true;
  for (; at < words.length; at++) {
    const word = (words[at] ?? "").replace(
      /^-(debug|debugger|dump-po-strings|dump-strings|help|init-file|login|noediting|noprofile|norc|posix|pretty-print|rcfile|restricted|verbose|version)$/,
      longAliases ? "--$1" : "$&",
    );
    if (word === "--" || word === "-") return script && at + 1 < words.length ? at + 1 : undefined;
    if (word === "--rcfile" || word === "--init-file") at++;
    else if (/^--[A-Za-z][A-Za-z-]*$/.test(word)) continue;
    else if (/^[-+][A-Za-z]+$/.test(word)) {
      longAliases = false;
      if (word.startsWith("-")) script ||= word.includes("c");
      at += word.slice(1).replace(/[^oO]/g, "").length;
    } else return script ? at : undefined;
  }
  return undefined;
};

/** The directories a command may run in; undefined is one not known. */
type Dirs = readonly (string | undefined)[];
// `path` as run in each of `dirs`.
const within = (dirs: Dirs, path: string): Dirs =>
  isAbsolute(path) ? [path] : dirs.map((dir) => (dir === undefined ? undefined : join(dir, path)));
const OPENS_LIST: Record<string, true> = { ";": true, "(": true, "$(": true, "`": true };
const OPENS_BODY: Record<string, true> = { if: true, while: true, until: true, for: true, case: true };
const CLOSES_BODY: Record<string, true> = { fi: true, done: true, esac: true };

/**
 * The words of a watch's argv (exact) or command string (split at whitespace, quotes trimmed) that may name a lane:
 * every word except its own command words. Anything else gives no words.
 */
export const laneWords = (command: unknown, cwd: unknown): readonly unknown[] => {
  const line = typeof command === "string" ? command : undefined;
  const raw: readonly unknown[] = line?.split(/\s+/).filter(Boolean) ?? (Array.isArray(command) ? command : []);
  // The whitespace-split word each character of the line is in.
  const baseOf: number[] = [];
  for (let at = 0, base = -1; at < (line?.length ?? 0); at++) {
    if (!/\s/.test(line?.[at] ?? "") && (at === 0 || /\s/.test(line?.[at - 1] ?? ""))) base++;
    baseOf.push(base);
  }
  // A string's words, where `baseAt` maps its characters to the line's whitespace-split words.
  const read = (text: string, baseAt: (at: number) => number): Word[] =>
    shellWords(text).map(({ text: word, from, after, scope }) => {
      const passed = unquote(word);
      const at = (i: number) => baseAt(from + (passed.at[i] ?? 0));
      const substitutions = () =>
        quotedSubstitutions(word).map((s) => read(word.slice(s.from, s.to), (i) => baseAt(from + s.from + i)));
      return { word: passed.text, baseAt: at, after, scope, script: () => read(passed.text, at), substitutions };
    });
  // A relative entry is the skill CLI only when it is in every directory the command may run in.
  const isDori = (word: string, dirs: Dirs): boolean =>
    DORI_NAMES[basename(word)] === true || within(dirs, word).every((path) => SKILL_SOURCE.test(path ?? word));
  const own = new Set<number>();

  // One command run in `dir`; for a `cd`, the directories it moves to.
  const commandOf = (ws: readonly Word[], dir: Dirs): Dirs | undefined => {
    const words = ws.map((w) => w.word);
    const mine = (at: number) => own.add(ws[at]?.baseAt(0) ?? -1);
    let at = 0;
    while (RESERVED.has(words[at] ?? "")) mine(at++);
    while (ASSIGNMENT.test(words[at] ?? "")) at++;
    while (PREFIXES[words[at] ?? ""] === true) {
      mine(at++);
      // exec's own options: `-a NAME` names the process, `-c` and `-l` are flags.
      while (words[at]?.startsWith("-")) at += words[at] === "-a" ? 2 : 1;
    }
    let here = dir;
    let program: number | undefined;
    for (let next: number | undefined = at; next !== undefined;) {
      at = next;
      next = undefined;
      while (ASSIGNMENT.test(words[at] ?? "")) at++;
      if (at >= words.length) break;
      mine(at);
      const name = basename(words[at] ?? "");
      const launcher = LAUNCHERS[name];
      if (isDori(words[at] ?? "", here)) program = at;
      else if (name === "cd") {
        const target = words.slice(at + 1).find((word) => !word.startsWith("-"));
        return target === undefined ? [undefined] : within(dir, target);
      } else if (name === "env") {
        const env = envCommandAt(words, at + 1);
        if (env?.chdir !== undefined) here = within(here, env.chdir);
        if (env?.split === undefined) next = env?.at;
        else {
          // `-S STRING`: env reads STRING's words, its own options included, then the words after it.
          const string = ws[env.at];
          const split = splitString(words[env.at]?.slice(env.split) ?? "").map((w): Word => ({
            word: w.text,
            baseAt: (i) => string?.baseAt((env.split ?? 0) + (w.at[i] ?? 0)) ?? -1,
          }));
          commandOf([ws[at] ?? { word: "env", baseAt: () => -1 }, ...split, ...ws.slice(env.at + 1)], here);
        }
      } else if (launcher !== undefined && Object.hasOwn(LAUNCHERS, name)) {
        next = launcherCommandAt(words, at + 1, launcher);
        // `flock LOCK -c CMD` runs CMD as a shell string.
        if (name === "flock" && next !== undefined && ["-c", "--command"].includes(words[next] ?? "")) {
          const script = ws[next + 1]?.script;
          if (script) run(script(), here);
          next = undefined;
        }
      } else if (name === "bun") {
        const entry = bunEntryAt(words, at + 1);
        const runs = entry?.cwd === undefined ? here : within(here, entry.cwd);
        if (entry === undefined || !isDori(words[entry.at] ?? "", runs)) break;
        for (let i = at; i < entry.at; i++) mine(i);
        program = entry.at;
      } else if (line !== undefined && SHELLS[name] === true) {
        const script = ws[scriptAt(words, at + 1) ?? -1]?.script;
        if (script) run(script(), here);
      }
    }
    if (program !== undefined) for (const i of doriOwnWords(words, program)) mine(i);
    return undefined;
  };

  // Each command of a run of words, cut where a new command starts. A `cd` moves the commands after it in its own
  // subshell or substitution, a new one starting where the one around it is. Only a `cd` that surely runs in this
  // shell replaces the directory: one starting a list, outside a condition or loop body, and not in a pipeline or the
  // background. One after `&&` or `||` or in a body adds its directory as possible; one in a pipeline changes nothing.
  // The commands after a `cd` joined to it by `&&` run where it moved (`cd X && true && B`), unless the `cd` itself
  // follows an `||` (`true || cd X && B` may run where it was); one after a later `||` in either directory, as anything
  // before it may have failed (`cd X && false || B`).
  const run = (ws: readonly Word[], dirs: Dirs): void => {
    const scopes = new Map<string, Dirs>([["", dirs]]);
    const dirOf = (scope: readonly number[]): Dirs => {
      const key = scope.join("/");
      if (!scopes.has(key)) scopes.set(key, dirOf(scope.slice(0, -1)));
      return scopes.get(key) ?? [undefined];
    };
    const commands: Word[][] = [];
    for (const w of ws) {
      const last = commands.at(-1);
      if (last === undefined || w.after !== undefined) commands.push([w]);
      else last.push(w);
    }
    let bodies = 0;
    // Per subshell, the last `cd` of the and-or list running now: where its `&&` chain runs (`to`), and where an `||`
    // after it may run (`from`). A command in another subshell neither reads nor ends it.
    const chains = new Map<string, { readonly to: Dirs; readonly from: Dirs }>();
    commands.forEach((command, index) => {
      const scope = command[0]?.scope ?? [];
      const key = scope.join("/");
      const after = command[0]?.after ?? ";";
      const first = command[0]?.word ?? "";
      if (OPENS_BODY[first] === true) bodies++;
      if (CLOSES_BODY[first] === true) bodies = Math.max(0, bodies - 1);
      const chain = chains.get(key);
      // An `||` is reached when anything before it failed, the `cd` or a command after it: from either directory.
      const either: Dirs | undefined = chain && [...new Set([...chain.from, ...chain.to])];
      if (either && after === "||") chains.set(key, { to: either, from: either });
      else if (after !== "&&") chains.delete(key);
      const here = chain && after === "&&" ? chain.to : either && after === "||" ? either : dirOf(scope);
      for (const w of command) for (const substitution of w.substitutions?.() ?? []) run(substitution, here);
      const to = commandOf(command, here);
      const next = commands[index + 1]?.[0]?.after;
      // An `&&` after this `cd` runs where it moved only if every way to that `&&` ran the `cd`: not after an `||`.
      if (to !== undefined) chains.set(key, { to: after === "||" ? [...new Set([...here, ...to])] : to, from: here });
      if (to === undefined || after === "|" || next === "|" || next === "&") return;
      const sure = OPENS_LIST[after] === true && bodies === 0;
      scopes.set(key, sure ? to : [...new Set([...dirOf(scope), ...to])]);
    });
  };
  run(
    line === undefined
      ? raw.map((word, base) => ({ word: typeof word === "string" ? word : "", baseAt: () => base }))
      : read(line, (at) => baseOf[at] ?? -1),
    [typeof cwd === "string" ? cwd : undefined],
  );
  return line === undefined
    ? raw.filter((_, at) => !own.has(at))
    : raw.map((word) => String(word).replace(/^['"]+|['"]+$/g, "")).filter((word, at) => word && !own.has(at));
};

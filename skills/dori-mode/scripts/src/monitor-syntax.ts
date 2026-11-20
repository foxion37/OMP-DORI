// The shell syntax a watch's command string is read with (monitor-command.ts): its words, what each passes on, the
// command substitutions inside double quotes, and `env -S`'s own splitting.

/**
 * One word of a command string: its text with quotes, where it is, the subshells and command substitutions it is in
 * (innermost last), and, where a new command starts at it, the operator before it (`;`, `&&`, `|`, `(`, ...; a line
 * break or the line's start is `;`).
 */
export type ShellWord = {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly after: string | undefined;
  readonly scope: readonly number[];
};

// Outside quotes these end a word and start a new command; the longer one first.
const OPERATORS = ["&&", "||", "$(", ";", "|", "&", "(", ")", "`"];

/** Where the backtick substitution whose command starts at `from` ends: its closing backtick, past escapes. */
const backtickEnd = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && text[at] !== "`") at += text[at] === "\\" ? 2 : 1;
  return Math.min(at, text.length);
};

/**
 * Where the `$(` substitution whose command starts at `from` ends: its closing `)`, past quoted parts, escapes, nested
 * substitutions and parentheses (`$(printf ')'; dori ...)`).
 */
const substitutionEnd = (text: string, from: number): number => {
  let depth = 0;
  let quote: string | undefined;
  for (let at = from; at < text.length; at++) {
    const char = text[at] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === "\\") at++;
    else if (text.startsWith("$(", at)) at = substitutionEnd(text, at + 2);
    else if (char === "`") at = backtickEnd(text, at + 1);
    else if (char === '"') quote = quote === undefined ? char : undefined;
    else if (quote === undefined && char === "'") quote = char;
    else if (quote === undefined && char === "(") depth++;
    else if (quote === undefined && char === ")" && depth-- === 0) return at;
  }
  return text.length;
};

/**
 * The words of `line`: split at whitespace and operators outside quotes, with or without spaces around them
 * (`true&&dori`, `a;b`); a line break starts a new command too. A quoted or backslash-escaped part stays in its word
 * (`rg -F \;`), a substitution inside double quotes too, and a backslash before a line break continues the line.
 */
export const shellWords = (line: string): ShellWord[] => {
  const words: ShellWord[] = [];
  let start = -1;
  let after: string | undefined = ";";
  let quote: string | undefined;
  // The open subshells and substitutions: their ids, and whether each is a backtick one.
  const scope: number[] = [];
  const backtick: boolean[] = [];
  let groups = 0;
  const end = (at: number): void => {
    if (start >= 0) words.push({ text: line.slice(start, at), from: start, to: at, after, scope: [...scope] });
    if (start >= 0) after = undefined;
    start = -1;
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\") {
      if (start < 0 && line[at + 1] === "\n") at++;
      else {
        if (start < 0) start = at;
        at++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (line.startsWith("$(", at)) at = substitutionEnd(line, at + 2);
      else if (char === "`") at = backtickEnd(line, at + 1);
      else if (char === quote) quote = undefined;
      continue;
    }
    const operator = OPERATORS.find((op) => line.startsWith(op, at));
    if (/\s/.test(char) || operator !== undefined) {
      end(at);
      if (char === "\n" || operator === ")") after = ";";
      else if (operator !== undefined) after = operator;
      if (operator === ")" || (operator === "`" && backtick.at(-1) === true)) {
        scope.pop();
        backtick.pop();
      } else if (operator === "(" || operator === "$(" || operator === "`") {
        scope.push(++groups);
        backtick.push(operator === "`");
      }
      at += (operator?.length ?? 1) - 1;
      continue;
    }
    if (start < 0) start = at;
    if (char === "'" || char === '"') quote = char;
  }
  end(line.length);
  return words;
};

/**
 * A word as the shell passes it on: quotes removed, escapes resolved (only `\"`, `\\`, `\$`, `` \` `` inside double
 * quotes), line continuations dropped; `at` maps each character back to its index in the word.
 */
export const unquote = (word: string): { readonly text: string; readonly at: readonly number[] } => {
  let text = "";
  const at: number[] = [];
  let quote: string | undefined;
  for (let i = 0; i < word.length; i++) {
    const char = word[i] ?? "";
    const next = word[i + 1] ?? "";
    if (quote !== "'" && char === "\\" && next === "\n") i++;
    else if (quote !== "'" && char === "\\" && next && (quote === undefined || '"\\$`'.includes(next))) {
      text += next;
      at.push(++i);
    } else if (char === quote || (quote === undefined && (char === "'" || char === '"')))
      quote = quote === undefined ? char : undefined;
    else {
      text += char;
      at.push(i);
    }
  }
  return { text, at };
};

/** The `$(...)` and backtick command substitutions inside a word's double quotes: where each one's command is. */
export const quotedSubstitutions = (word: string): { readonly from: number; readonly to: number }[] => {
  const found: { from: number; to: number }[] = [];
  let quote: string | undefined;
  for (let at = 0; at < word.length; at++) {
    const char = word[at] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
    } else if (char === "\\") at++;
    else if (quote === '"' && (char === "`" || word.startsWith("$(", at))) {
      const from = at + (char === "`" ? 1 : 2);
      at = char === "`" ? backtickEnd(word, from) : substitutionEnd(word, from);
      found.push({ from, to: at });
    } else if (char === quote) quote = undefined;
    else if (quote === undefined && (char === "'" || char === '"')) quote = char;
  }
  return found;
};

/**
 * `env -S STRING`'s words: split at whitespace and `\_` outside quotes, quotes removed, a backslash escaping the next
 * character (`\_` inside double quotes is a space); `at` maps each character back to its index in STRING.
 */
export const splitString = (line: string): { readonly text: string; readonly at: readonly number[] }[] => {
  const words: { text: string; at: number[] }[] = [];
  let word: { text: string; at: number[] } | undefined;
  let quote: string | undefined;
  const add = (char: string, at: number): void => {
    word ??= { text: "", at: [] };
    word.text += char;
    word.at.push(at);
  };
  const split = (): void => {
    if (word) words.push(word);
    word = undefined;
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? "";
    if (quote === "'" && char !== "'") add(char, at);
    else if (char === "\\" && quote !== "'" && at + 1 < line.length) {
      const next = line[++at] ?? "";
      if (next !== "_") add(next, at);
      else if (quote === undefined) split();
      else add(" ", at);
    } else if (char === quote) quote = undefined;
    else if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
      word ??= { text: "", at: [] };
    } else if (quote === undefined && /\s/.test(char)) split();
    else add(char, at);
  }
  split();
  return words;
};

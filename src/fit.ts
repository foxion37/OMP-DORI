// Terminal text helpers: wide (Korean) characters take two columns, and a cut never splits a character.

/** Target terminal width; a full reference wider than a line stays whole, including any spaces in it. */
export const WIDTH = 120;

const graphemes = (text: string): string[] =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);

/** The leading graphemes of `parts` that fit in `cols` columns. */
function keep(parts: readonly string[], cols: number): string[] {
  const out: string[] = [];
  let width = 0;
  for (const g of parts) {
    width += Bun.stringWidth(g);
    if (width > cols) break;
    out.push(g);
  }
  return out;
}

/** `text` cut to `cols` terminal columns from the end, ending in "…" when cut. */
export const fitEnd = (text: string, cols: number): string =>
  Bun.stringWidth(text) <= cols ? text : `${keep(graphemes(text), cols - 1).join("")}…`;

/** `text` cut to `cols` terminal columns from the start, so a long path keeps its file name: "…/dir/file.md". */
export const fitStart = (text: string, cols: number): string =>
  Bun.stringWidth(text) <= cols
    ? text
    : `…${keep(graphemes(text).reverse(), cols - 1)
        .reverse()
        .join("")}`;

/** `text` padded with spaces to `cols` terminal columns (cut first when longer). */
export function padCols(text: string, cols: number): string {
  const fitted = fitEnd(text, cols);
  return fitted + " ".repeat(Math.max(0, cols - Bun.stringWidth(fitted)));
}

/**
 * `text` on one line: control characters (line breaks and terminal escapes included) and bidi overrides become a space,
 * and runs of spaces one space, so lane-supplied text cannot break a line, recolour the terminal or add a line of its own.
 */
export const oneLine = (text: string): string =>
  text.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\s]+/gu, " ").trim();

/**
 * A name (a path, a link, what a lane waits on) on one line: like `oneLine`, a run of control characters and bidi
 * overrides becomes one space, but the printable spaces it has stay as they are, untrimmed: `build  artifacts` is
 * another path than `build artifacts`, so a name shown whole is the name the lane gave.
 */
export const oneName = (text: string): string => text.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ");

/**
 * `text` broken into lines of at most `cols` columns, at a space only. A word wider than that (a link, a job id, a path)
 * is never split: its line runs on to the next space and the terminal folds it for display. A split one is two lines,
 * neither of which a reader can copy, click or search for.
 */
export function wrap(text: string, cols: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (Bun.stringWidth(rest) > cols) {
    const head = keep(graphemes(rest), cols).join("");
    const fits = rest[head.length] === " " ? head.length : head.lastIndexOf(" ");
    const cut = fits > 0 ? fits : rest.indexOf(" ", head.length);
    if (cut < 0) break;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return [...lines, rest];
}

/**
 * `text` whole on one indented line: a cut link, job id or path names nothing a reader can open or check, so a line that
 * has to stay short is followed by this when it cut one. Never wrapped, not even at a space: the text is one name (a
 * path may hold spaces), and either half of a broken one names nothing. Wider than a line, the terminal folds it.
 */
export const indented = (text: string): string[] => [`  ${text}`];

/** Local wall-clock time, "19:47". */
export function hhmm(at: number): string {
  const t = new Date(at);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** A duration as a person reads it: "45m", "2h10m", "1d3h". */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

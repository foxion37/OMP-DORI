/**
 * Where to cut `text` (longer than `limit`) so the first part fits: just after the last of the first `breaks` found in
 * the back half of the window, tried in order, else at `limit`. A cut never separates a UTF-16 surrogate pair.
 */
export const cutAt = (text: string, limit: number, breaks: readonly string[]): number => {
  const window = text.slice(0, limit);
  let at = limit;
  for (const mark of breaks) {
    const found = window.lastIndexOf(mark);
    if (found >= limit / 2) {
      at = found + mark.length;
      break;
    }
  }
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) at--;
  return at;
};

/** Discord's message content limit; counting UTF-16 code units never undercounts its characters. */
export const DISCORD_LIMIT = 2000;
/** A code block marker as Discord's renderer reads it: any run of three or more backticks, wherever it sits. */
const FENCE_RUN = /`{3,}/g;
/** The language an opening marker names: letters and the like up to the end of its line. */
const LANGUAGE = /^([a-z0-9_+\-.#]{1,32})\r?\n/i;

/**
 * Discord pairs block markers in order, so a block opens at every odd marker and closes at the next one, mid-line and
 * on one line (```js f()```) included. Returns the language of the block still open at the end of `text`, or
 * undefined when every block is closed.
 */
const openBlock = (text: string): { readonly language: string; readonly at: number } | undefined => {
  let open: { readonly language: string; readonly at: number } | undefined;
  for (const m of text.matchAll(FENCE_RUN)) {
    if (open !== undefined) open = undefined;
    else open = { language: LANGUAGE.exec(text.slice(m.index + m[0].length))?.[1] ?? "", at: m.index };
  }
  return open;
};

/** Moves a cut that falls inside a run of backticks to the run's start, so neither part loses a marker. */
const outsideRun = (text: string, at: number): number => {
  let moved = at;
  while (moved > 0 && text[moved - 1] === "`" && text[moved] === "`") moved--;
  return moved > 0 ? moved : at;
};

/**
 * Break text into Discord messages of at most 2000 UTF-16 code units, preferring a blank line, then a newline, then a
 * space in the back half of each window. A code block cut across parts is closed at the end of one part and reopened
 * with its language at the start of the next, so each part renders on its own; when the cut falls just before the
 * block's own closing marker, that marker ends the part instead. Parts that would hold only whitespace are dropped
 * (Discord refuses empty messages); otherwise the text is unchanged.
 */
export const splitForDiscord = (text: string): string[] => {
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (reopen.length + rest.length > DISCORD_LIMIT) {
    let budget = DISCORD_LIMIT - reopen.length;
    for (;;) {
      const at = outsideRun(rest, cutAt(rest, budget, ["\n\n", "\n", " "]));
      const part = reopen + rest.slice(0, at);
      const block = openBlock(part);
      // A block opened by this part's text with nothing after its marker line moves whole to the next part.
      const opener = block === undefined ? -1 : part.lastIndexOf("\n", block.at) + 1 - reopen.length;
      if (block && opener > 0 && !/\S/.test(part.slice(block.at).replace(/^`+[^\n]*\n?/, ""))) {
        budget = opener;
        continue;
      }
      const close = block === undefined ? "" : `${part.endsWith("\n") ? "" : "\n"}\`\`\``;
      if (part.length + close.length > DISCORD_LIMIT) {
        budget -= close.length;
        continue;
      }
      parts.push(part + close);
      rest = rest.slice(at);
      reopen = "";
      if (block !== undefined) {
        // The block's own closing marker right after the cut is the one just added: drop it rather than reopen.
        const closer = /^`{3,}/.exec(rest);
        if (closer) rest = rest.slice(closer[0].length);
        else reopen = `\`\`\`${block.language}\n`;
      }
      break;
    }
  }
  parts.push(reopen + rest);
  const kept = parts.filter((part) => part.trim() !== "");
  return kept.length > 0 ? kept : parts.slice(0, 1);
};

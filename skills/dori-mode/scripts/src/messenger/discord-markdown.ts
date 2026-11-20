/**
 * Opt-in bounded Discord table formatting, adapted from omp-superagent
 * db3d74e4f37191dfbb74f8259563d1399c22f3b7/src/discord-markdown.ts.
 * Copyright (c) 2026 dbc-hbin. MIT license and permission notice: NOTICE.
 */

type Align = "left" | "center" | "right";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;
const BACKTICK_RUN = /`{3,}/;
const BLOCK_START = /^(?: {4}| *\t)|^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * Split one table row into trimmed cells.
 * Returns null when the line carries no unescaped pipe, so callers can end a
 * table body. Undefined marks ambiguous syntax, including a code span crossing
 * a line: do not reinterpret any part of that message. Escapes and code-span
 * pipes are preserved as cell content.
 */
function splitRow(line: string): string[] | null | undefined {
  if (/\p{Cc}|`{3,}/u.test(line.replace(/\r$/, ""))) return undefined;
  const cells: string[] = [];
  let cell = "";
  let pipe = false;
  let leading = false;
  let tick = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\" && tick === 0 && index + 1 < line.length) {
      // Keep source escapes verbatim and respect even/odd backslash runs.
      // Within a code span, backslashes are ordinary content.
      cell += char + line[index + 1];
      index++;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (line[index + run] === "`") run++;
      tick = tick === run ? 0 : tick === 0 ? run : tick;
      cell += "`".repeat(run);
      index += run - 1;
      continue;
    }
    if (char === "|" && tick === 0) {
      if (!pipe) leading = cell.trim() === "";
      pipe = true;
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  if (tick !== 0) return undefined;
  if (!pipe) return null;
  cells.push(cell);
  if (leading) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.length > 0 ? cells.map((value) => value.trim()) : null;
}

/** The delimiter row must have the same cell count as the header, as in GFM. */
function parseDelimiter(line: string): Align[] | null {
  const cells = splitRow(line);
  if (!cells) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!DELIMITER_CELL.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

function pad(value: string, width: number, align: Align): string {
  const missing = width - Bun.stringWidth(value);
  if (missing <= 0) return value;
  if (align === "right") return " ".repeat(missing) + value;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + value + " ".repeat(missing - left);
  }
  return value + " ".repeat(missing);
}

/** Measure a replacement without allocating padded cells or separators. */
function measureTable(rows: string[][], columns: number, indent: string): { widths: number[]; bytes: number } | null {
  const widths = Array<number>(columns).fill(3);
  for (const row of rows) {
    for (let column = 0; column < row.length; column++) {
      widths[column] = Math.max(widths[column]!, Bun.stringWidth(row[column]!));
    }
  }
  // Each row has a frame, display-width cells, and one newline. UTF-8 cell
  // bytes may exceed their display width; the separator contains only ASCII.
  const rowWidth = indent.length + 3 * widths.length + 1 + widths.reduce((sum, width) => sum + width, 0);
  if (rowWidth > 80) return null;
  let bytes = indent.length + 6 + rows.length + 2 + (rows.length + 1) * rowWidth;
  for (const row of rows) {
    for (const cell of row) bytes += Buffer.byteLength(cell, "utf8") - Bun.stringWidth(cell);
  }
  return { widths, bytes };
}

type TableReplacement = {
  start: number;
  end: number;
  rows: string[][];
  aligns: Align[];
  widths: number[];
  indent: string;
};

function writeTable(out: string[], { rows, aligns, widths, indent }: TableReplacement): void {
  const fence = indent + "```";
  const line = (cells: string[]) =>
    `${indent}| ${widths.map((width, column) => pad(cells[column]!, width, aligns[column]!)).join(" | ")} |`;
  // Pure dashes keep the grid exact; alignment is already visible in the padded
  // cells, and `:` markers would only shift every following column by one.
  const separator = `${indent}| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  out.push(fence, line(rows[0]!), separator);
  for (let index = 1; index < rows.length; index++) out.push(line(rows[index]!));
  // The splitter recognizes a closer at the cut only at column zero.
  out.push("```");
}

/**
 * Rewrite unambiguous pipe tables as fenced blocks of at most 80 display columns.
 *
 * Everything else passes through byte for byte: prose, lists, headings, links,
 * blockquotes, inline code, and existing fenced blocks. Pipes inside a fence are
 * never treated as a table, and an already-converted table stays inside its own
 * fence, so the transform is idempotent. Ambiguous rows/fences or alignment beyond
 * the complete message byte budget leave the original text on the existing path.
 * The caller supplies the byte limit; padding is allocated only after checking it.
 */
export function renderDiscordTables(text: string, maxBytes: number): string {
  if (!text.includes("|")) return text;
  let bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) return text;
  const lines = text.split("\n");
  const tables: TableReplacement[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      // The splitter toggles on every backtick run, even inside a longer or
      // tilde fence. Preserve the full source if a run is not our closer.
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      else if (BACKTICK_RUN.test(line)) return text;
      continue;
    }
    const opener = FENCE_OPEN.exec(line);
    if (opener) {
      if (BACKTICK_RUN.test(line.slice(opener[0].length))) return text;
      const marker = opener[1]!;
      fence = { char: marker[0]!, length: marker.length };
      continue;
    }
    // The existing splitter treats backtick runs anywhere as fences. Never
    // reinterpret inline or nested fence syntax outside a recognized block.
    if (/`{3,}|~{3,}/.test(line)) return text;
    const header = splitRow(line);
    if (header === undefined) return text;
    const delimiterLine = lines[index + 1];
    if (delimiterLine === undefined || BLOCK_START.test(line) || BLOCK_START.test(delimiterLine)) continue;
    const delimiter = parseDelimiter(delimiterLine);
    if (delimiter && (!header || header.length !== delimiter.length)) return text;
    if (!delimiter || !header) continue;
    const rows = [header];
    let sourceBytes = Buffer.byteLength(line, "utf8") + 1 + Buffer.byteLength(delimiterLine, "utf8");
    let next = index + 2;
    for (; next < lines.length; next++) {
      if (FENCE_OPEN.test(lines[next]!) || BLOCK_START.test(lines[next]!)) break;
      const row = splitRow(lines[next]!);
      if (!row) {
        if (lines[next]!.includes("|")) return text;
        break;
      }
      if (row.length !== delimiter.length) return text;
      rows.push(row);
      sourceBytes += 1 + Buffer.byteLength(lines[next]!, "utf8");
    }
    const indent = /^ */.exec(line)![0];
    const measured = measureTable(rows, delimiter.length, indent);
    if (!measured) return text;
    bytes += measured.bytes - sourceBytes;
    tables.push({ start: index, end: next, rows, aligns: delimiter, widths: measured.widths, indent });
    index = next - 1;
  }
  // A later replacement can shrink the message. Only the final total tells us
  // whether any padding can be allocated.
  if (!tables.length || bytes > maxBytes) return text;
  const out: string[] = [];
  let index = 0;
  for (const table of tables) {
    while (index < table.start) out.push(lines[index++]!);
    writeTable(out, table);
    index = table.end;
  }
  while (index < lines.length) out.push(lines[index++]!);
  return out.join("\n");
}

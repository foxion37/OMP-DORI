import { expect, spyOn, test } from "bun:test";
import { renderDiscordTables } from "../src/messenger/discord-markdown.ts";

const budget = 64 * 1024;
const fence = "\x60\x60\x60";
const table = "| a |\n| --- |\n| b |";
const render = (text: string, limit = budget) => renderDiscordTables(text, limit);

test("left, center and right alignment use display columns rather than UTF-16 length", () => {
  const text = "| left | center | right |\n| :--- | :---: | ---: |\n| A | \ud55c | \u{1f642} |";
  expect(render(text)).toBe(
    [
      fence,
      "| left | center | right |",
      "| ---- | ------ | ----- |",
      "| A    |   \ud55c   |    \u{1f642} |",
      fence,
    ].join("\n"),
  );
});

test("CJK, combining marks and joined emoji retain their bytes and align to the same width", () => {
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  const text = [
    "| \uc774\ub984 | \uac12 |",
    "| --- | --- |",
    "| \ud55c\uae00 | 1 |",
    "| e\u0301 | \u{1f642} |",
    "| " + family + " | 12 |",
  ].join("\n");
  const output = render(text);
  expect(output).toStartWith(fence + "\n");
  expect(output).toContain(family);
  expect(output).toContain("e\u0301");
  for (const line of output.split("\n").slice(1, -1)) expect(Bun.stringWidth(line)).toBe(14);
});

test("escaped pipes and one- or two-backtick code spans remain literal cell content", () => {
  const text = "| a\\|b | \x60c|d\x60 |\n| --- | --- |\n| e | \x60\x60f|\x60g\x60\x60 |";
  const output = render(text);
  expect(output).toStartWith(fence + "\n");
  for (const cell of ["a\\|b", "\x60c|d\x60", "\x60\x60f|\x60g\x60\x60"]) expect(output).toContain(cell);
  for (const line of output.split("\n").slice(1, -1)) expect(Bun.stringWidth(line)).toBe(19);
});

test("backslash parity and escaped backticks do not invent or hide column separators", () => {
  const slash = String.fromCharCode(92);
  for (const cell of ["a" + slash.repeat(2), "a" + slash.repeat(3) + "|b", "a\\\x60", "\x60a\\\x60"]) {
    const text = "| " + cell + "| c |\n| --- | --- |\n| x | y |";
    const output = render(text);
    expect(output).toStartWith(fence + "\n");
    expect(output).toContain(cell);
  }
});

test("outer pipes are optional and missing body rows are valid", () => {
  const text = "name | count\n--- | ---:\none | 2";
  expect(render(text)).toBe([fence, "| name | count |", "| ---- | ----- |", "| one  |     2 |", fence].join("\n"));
  expect(render("| a |\n| --- |")).toBe([fence, "| a   |", "| --- |", fence].join("\n"));
});

test.each([
  ["\x60\x60\x60js", "\x60\x60\x60"],
  ["\x60\x60\x60\x60md", "\x60\x60\x60\x60"],
  ["~~~text", "~~~"],
])("existing %s fences and their table-looking content pass through unchanged", (open, close) => {
  const text = "before\n" + open + "\n" + table + "\n" + close + "\nafter";
  expect(render(text)).toBe(text);
  expect(render(text + "\n\n" + table)).toBe(text + "\n\n" + render(table));
});

test("shorter or differently typed fences cannot close an existing block", () => {
  const text = "\x60\x60\x60\x60\n" + table + "\n\x60\x60\x60\n~~~\n" + table + "\n\x60\x60\x60\x60";
  expect(render(text)).toBe(text);
  expect(render("~~~\n" + table + "\n\x60\x60\x60\n" + table)).toBe("~~~\n" + table + "\n\x60\x60\x60\n" + table);
});

test.each([
  [fence + "\x60", fence, fence + "\x60"],
  ["~~~md", fence, "~~~"],
  [fence + "js " + fence, "literal", fence],
  [fence + "js", fence + " trailing text", fence],
])("splitter-incompatible fences preserve tables before and after the block: %s", (open, content, close) => {
  const text = [table, "", open, content, close, "", table].join("\n");
  expect(render(text)).toBe(text);
});

test.each([
  "prefix \x60\x60\x60code\x60\x60\x60",
  "    \x60\x60\x60",
  "- \x60\x60\x60",
  "> ~~~",
  "before \x60multiline",
])("ambiguous or nested fence and inline-code syntax is not reinterpreted: %s", (prefix) => {
  const text = prefix + "\n" + table + "\nafter";
  expect(render(text)).toBe(text);
});

test.each([
  "prose | with a pipe",
  "# title | other\n| --- | --- |",
  "> a | b\n> --- | ---\n> c | d",
  "- a | b\n| --- | --- |\n| c | d |",
  "    | a | b |\n    | --- | --- |\n    | c | d |",
  "| a |\n    | --- |\n    | b |",
  "| a |\n \t| --- |\n \t| b |",
  "| a | b |\n| --- |\n| c | d |",
  "| a | b |\n| --- | --- |\n| c |",
  "| a | b |\n| --- | --- |\n| c | d | e |",
  "| a |\n| --- |\n| \x60unclosed |",
  "| a |\n| --- |\n| x\ty |",
  "| a |\n| --- |\n| x\u001by |",
  "| a |\n| --- |\n| \x60\x60\x60literal |",
])("non-table prose, blocks and ambiguous rows preserve the complete source: %s", (text) => {
  expect(render(text)).toBe(text);
});

test("leading indentation and bytes outside transformed tables are retained", () => {
  const indented = table
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
  const expected = render(table).split("\n");
  expect(render(indented)).toBe(
    expected.map((line, index) => (index === expected.length - 1 ? line : "  " + line)).join("\n"),
  );
  const bytes = Buffer.byteLength(render(indented));
  expect(render(indented, bytes)).toBe(render(indented));
  expect(render(indented, bytes - 1)).toBe(indented);
  expect(render(render(indented))).toBe(render(indented));
  const text = "intro  \r\n" + table.replaceAll("\n", "\r\n") + "\r\noutro  \r\n";
  expect(render(text)).toBe("intro  \r\n" + render(table) + "\noutro  \r\n");
});

test("the exact complete-message UTF-8 budget includes fences, newlines and wide cells", () => {
  for (const input of [
    table,
    table.replace("b", "\u00e9"),
    table.replace("b", "\ud55c"),
    "before\n" + table + "\nafter",
  ]) {
    const output = render(input);
    const bytes = Buffer.byteLength(output);
    expect(output).not.toBe(input);
    expect(render(input, bytes)).toBe(output);
    expect(render(input, bytes - 1)).toBe(input);
  }
});

test("multiple tables share one budget and never leave a partially transformed message", () => {
  const text = table + "\n\n" + table;
  const output = render(table) + "\n\n" + render(table);
  expect(render(text, Buffer.byteLength(output))).toBe(output);
  expect(render(text, Buffer.byteLength(output) - 1)).toBe(text);
});

test("a later shrinking replacement can offset earlier expansion, but cannot lift the source cap", () => {
  const longDelimiter = table.replace("---", "-".repeat(48));
  const text = table + "\n\n" + longDelimiter;
  const output = render(table) + "\n\n" + render(table);
  const sourceBytes = Buffer.byteLength(text);
  expect(Buffer.byteLength(output)).toBeLessThan(sourceBytes - 1);
  expect(render(text, sourceBytes)).toBe(output);
  expect(render(text, sourceBytes - 1)).toBe(text);
});

test("width and total padding bounds are checked before padded strings are allocated", () => {
  const cases = [
    { text: table, limit: Buffer.byteLength(render(table)) - 1 },
    { text: table + "\n\n" + table, limit: Buffer.byteLength(render(table)) * 2 + 1 },
    { text: "| a |\n| --- |\n| " + "x".repeat(80) + " |", limit: budget },
    { text: ["x|".repeat(2000), "---|".repeat(2000), "y|".repeat(2000)].join("\n"), limit: budget },
    {
      text: ["| a |", "| --- |", "| " + "x".repeat(60) + " |", ...Array(2000).fill("| b |")].join("\n"),
      limit: budget,
    },
  ];
  for (const { text, limit } of cases) {
    const repeat = spyOn(String.prototype, "repeat");
    let observed: { text: string; repeats: number } | undefined;
    try {
      observed = { text: render(text, limit), repeats: repeat.mock.calls.length };
    } finally {
      repeat.mockRestore();
    }
    expect(observed).toEqual({ text, repeats: 0 });
  }
  const tooLarge = table + "\n" + "x".repeat(budget);
  expect(render(tooLarge)).toBe(tooLarge);
});

test("80 display columns are allowed exactly, including preserved indentation", () => {
  for (const indent of ["", "  "]) {
    const width = 76 - indent.length;
    const text = ["| h |", "| --- |", "| " + "x".repeat(width) + " |"].map((line) => indent + line).join("\n");
    const output = render(text);
    expect(output).not.toBe(text);
    for (const line of output.split("\n").slice(1, -1)) expect(Bun.stringWidth(line)).toBe(80);
    const wider = text.replace("x".repeat(width), "x".repeat(width + 1));
    expect(render(wider)).toBe(wider);
  }
});

test("bounded Unicode tables stay rectangular, lossless and idempotent across varied shapes", () => {
  const cells = ["a", "\ud55c\uae00", "e\u0301", "\u{1f642}", "x\\|y", "\x60a|b\x60"];
  for (let sample = 0; sample < 64; sample++) {
    const columns = (sample % 3) + 1;
    const rows = Array.from({ length: (sample % 5) + 1 }, (_, row) =>
      Array.from({ length: columns }, (_, column) => cells[(sample + row + column) % cells.length]!),
    );
    const sourceRows = [rows[0]!, Array(columns).fill("---:"), ...rows.slice(1)];
    const text = sourceRows.map((row) => "| " + row.join(" | ") + " |").join("\n");
    const output = render(text);
    expect(output).toStartWith(fence + "\n");
    expect(render(output)).toBe(output);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(budget);
    const widths = output
      .split("\n")
      .slice(1, -1)
      .map((line) => Bun.stringWidth(line));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(80);
    for (const row of rows) for (const cell of row) expect(output).toContain(cell);
  }
});

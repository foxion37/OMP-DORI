import { expect, test } from "bun:test";
import { DISCORD_LIMIT, splitForDiscord } from "../src/messenger/split.ts";

/** Block markers as Discord pairs them: every run of three or more backticks. */
const fenceLines = (part: string) => part.match(/`{3,}/g)?.length ?? 0;

test("text within the limit is one part; longer text never exceeds 2000 UTF-16 code units and loses nothing", () => {
  expect(splitForDiscord("short")).toEqual(["short"]);
  expect(splitForDiscord("z".repeat(DISCORD_LIMIT))).toEqual(["z".repeat(DISCORD_LIMIT)]);
  expect(splitForDiscord("z".repeat(DISCORD_LIMIT + 1)).map((p) => p.length)).toEqual([DISCORD_LIMIT, 1]);
  const prose = Array.from({ length: 300 }, (_, i) => `line ${i} of a long report with words`).join("\n");
  const parts = splitForDiscord(prose);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(DISCORD_LIMIT);
  expect(parts.join("")).toBe(prose);
});

test("a blank line is preferred over a later newline, a newline over a space, a space over a hard cut", () => {
  const para = `${"a".repeat(1200)}\n\n${"b".repeat(300)}\n${"c".repeat(600)}`;
  expect(splitForDiscord(para)[0]).toBe(`${"a".repeat(1200)}\n\n`);
  const line = `${"a".repeat(1200)}\n${"b".repeat(300)} ${"c".repeat(600)}`;
  expect(splitForDiscord(line)[0]).toBe(`${"a".repeat(1200)}\n`);
  const words = `${"a".repeat(1500)} ${"b".repeat(600)}`;
  expect(splitForDiscord(words)[0]).toBe(`${"a".repeat(1500)} `);
});

test("a cut never separates a surrogate pair", () => {
  const emoji = "\u{1f600}".repeat(1500);
  const parts = splitForDiscord(`x${emoji}`);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(part).toBe(part.toWellFormed());
  }
  expect(parts.join("")).toBe(`x${emoji}`);
});

test("a code block cut across parts is closed and reopened with its fence line, so each part renders alone", () => {
  const code = Array.from({ length: 120 }, (_, i) => `const value${i} = compute(${i}); // step`).join("\n");
  const text = `Report\n\n\`\`\`ts\n${code}\n\`\`\`\nAfter the block.`;
  const parts = splitForDiscord(text);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(fenceLines(part) % 2).toBe(0);
  }
  for (const part of parts.slice(1)) expect(part).toStartWith("```ts\n");
  for (const part of parts.slice(0, -1)) expect(part).toEndWith("\n```");
  // Removing the added closing and opening fences gives the original text back.
  const restored = parts
    .map((part, i) => (i < parts.length - 1 ? part.slice(0, -"```".length) : part))
    .map((part, i) => (i > 0 ? part.slice("```ts\n".length) : part))
    .join("");
  expect(restored).toBe(text);
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i} ${"x".repeat(30)}`).join("\n");

test("markers pair as Discord renders them: one-line and mid-line closers close, CRLF openers keep their language", () => {
  // A one-line block at the start of a line is closed on that line: no marker is added around the cut.
  const oneLine = `\`\`\`js f()\`\`\`\n${rows(80)}`;
  expect(splitForDiscord(oneLine).join("")).toBe(oneLine);
  // A closer followed by text on its line still closes the block.
  const midLine = `\`\`\`ts\n${rows(10)}\n\`\`\` trailing words\n${rows(70)}`;
  expect(splitForDiscord(midLine).join("")).toBe(midLine);
  // A CRLF body reopens the cut block with its language.
  const crlf = `\`\`\`ts\r\n${rows(80).replaceAll("\n", "\r\n")}\r\n\`\`\``;
  const parts = splitForDiscord(crlf);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts[1]).toStartWith("```ts\n");
  for (const part of parts) expect(fenceLines(part) % 2).toBe(0);
});

test("a cut just before a block's own closing marker ends the part with it instead of opening an empty block", () => {
  // The last break inside the limit is the newline before the closer, which runs on into text past the limit.
  const body = "y".repeat(1990);
  const text = `\`\`\`\n${body}\n\`\`\`${"z".repeat(50)}\nafter the block`;
  expect(splitForDiscord(text)).toEqual([`\`\`\`\n${body}\n\`\`\``, `${"z".repeat(50)}\nafter the block`]);
});

test("a space before a block's closing marker does not reopen an empty block", () => {
  const block = `\`\`\`\n${"y ".repeat(990)}`;
  const tail = "z".repeat(200);
  expect(splitForDiscord(`${block}\`\`\`${tail}`)).toEqual([`${block}\n\`\`\``, tail]);
});

test("a part never ends on a block's opening line, and a hard cut never splits a run of backticks", () => {
  const code = "code line\n".repeat(100);
  const opening = `${"a".repeat(1990)}\n\`\`\`ts\n${code}\`\`\``;
  const parts = splitForDiscord(opening);
  expect(parts[0]).toBe(`${"a".repeat(1990)}\n`);
  expect(parts[1]).toStartWith("```ts\ncode line\n");
  expect(parts.join("")).toBe(opening);
  const run = `${"x".repeat(1999)}\`\`\`ts\n${code}\`\`\``;
  const cut = splitForDiscord(run);
  expect(cut[0]).toBe("x".repeat(1999));
  expect(cut[1]).toStartWith("```ts\n");
  expect(cut.join("")).toBe(run);
});

test("an overlong or odd language reopens the block with its markers alone", () => {
  const parts = splitForDiscord(`\`\`\`\`${"i".repeat(70)}\n${rows(80)}\n\`\`\`\``);
  expect(parts[0]).toEndWith("\n```");
  expect(parts[1]).toStartWith("```\n");
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(fenceLines(part) % 2).toBe(0);
  }
});

test("parts that would be whitespace only are dropped, since Discord refuses empty messages", () => {
  const text = `${"a".repeat(1990)}\n${"\n".repeat(2500)}tail`;
  const parts = splitForDiscord(text);
  expect(parts.every((part) => part.trim() !== "")).toBe(true);
  expect(parts.at(-1)).toEndWith("tail");
});

test("a long run of backticks is one marker and every part still fits with its blocks balanced", () => {
  const parts = splitForDiscord(`${"`".repeat(100)}\n${"y ".repeat(1500)}\n\`\`\``);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(fenceLines(part) % 2).toBe(0);
  }
});

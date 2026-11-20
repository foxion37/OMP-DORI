import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resumeFile } from "../src/lifecycle-session.ts";
import { parkLane } from "../src/park.ts";
import { reopenLane } from "../src/reopen.ts";
import { statusOf } from "../src/registry.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

/** OMP's fixed-width title slot: the first physical line, exactly 256 UTF-8 bytes including its newline. */
const titleSlot = (fields: Record<string, unknown> = {}): string => {
  const slot = {
    type: "title",
    v: 1,
    title: "📋 lane",
    source: "auto",
    updatedAt: "2026-01-01T12:00:01.000Z",
    ...fields,
  };
  const pad = 256 - Buffer.byteLength(`${JSON.stringify({ ...slot, pad: "" })}\n`);
  return `${JSON.stringify({ ...slot, pad: " ".repeat(pad) })}\n`;
};
const header = (fields: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ type: "session", version: 3, id: f.session, cwd: f.deps.config.defaultCwd, ...fields })}\n`;

test("park and reopen accept a saved session that starts with OMP's title slot", async () => {
  writeFileSync(f.file, `${titleSlot()}${header()}`);
  const parked = await parkLane(f.deps, f.lane, "wait");
  expect(parked.code).toBe(0);
  expect(statusOf(parked.lane)).toBe("closed");
  const reopened = await reopenLane(f.deps, parked.lane);
  expect(reopened.code).toBe(0);
  expect(f.creates()).toBe(1);
});

test.each([
  ["legacy header first", () => header()],
  ["title slot then header", () => `${titleSlot()}${header()}`],
  ["title slot without source", () => `${titleSlot({ source: undefined })}${header()}`],
  ["user title slot", () => `${titleSlot({ source: "user" })}${header()}`],
  // JSON.stringify leaves U+2028/U+2029 raw; OMP splits records only at LF.
  ["title with line and paragraph separators", () => `${titleSlot({ title: "a\u2028b\u2029c" })}${header()}`],
  ["CRLF records", () => `${titleSlot().replace(/\n$/, "\r\n")}${header().replace(/\n$/, "\r\n")}`],
  ["header without a final newline", () => `${titleSlot()}${header().trimEnd()}`],
])("%s resolves the saved session file", async (_name, body) => {
  writeFileSync(f.file, body());
  expect(await resumeFile(f.deps, f.lane)).toBe(f.file);
});

const differs = "identity or cwd differs";
test.each([
  ["another record type first", () => `${JSON.stringify({ type: "model_change", id: "m1" })}\n${header()}`, differs],
  ["title slot of an unknown version", () => `${titleSlot({ v: 2 })}${header()}`, differs],
  ["two title slots", () => `${titleSlot()}${titleSlot()}${header()}`, differs],
  ["title slot without a header", () => titleSlot(), "is empty"],
  ["title slot then another record", () => `${titleSlot()}${JSON.stringify({ type: "message", id: "m1" })}\n`, differs],
  ["title slot then a foreign session id", () => `${titleSlot()}${header({ id: "foreign" })}`, differs],
  ["title slot then another cwd", () => `${titleSlot()}${header({ cwd: f.state.dir })}`, differs],
  // OMP keeps a lone CR inside its first physical line, so that title is not a slot there either.
  [
    "title slot joined to the header by a lone CR",
    () => `${titleSlot().replace(/\n$/, "\r")}${header()}`,
    "or cwd unavailable (invalid session header)",
  ],
  // The 1 MiB header window ends inside this record, whose parsable prefix is only padding before junk.
  [
    "header record cut off by the read limit",
    () => `${header().trimEnd()}${" ".repeat(1024 * 1024)}junk\n`,
    "header is too long",
  ],
])("%s is refused", async (_name, body, reason) => {
  writeFileSync(f.file, body());
  await expect(resumeFile(f.deps, f.lane)).rejects.toThrow(`saved session ${reason}`);
});

import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import { openOwes, recordMark, recordOwes, recordSent } from "../src/owes.ts";
import { withState } from "./fakes.ts";

const inbound = (id: string) => `INBOUND discord 20 ${id} from=owner ref=- "question"`;

for (const tail of ["intact", "inbound", "sent", "marks"] as const) {
  test(`${tail}: the next valid record survives an unterminated torn tail`, async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, inbound("100"), 1000);
      const path = (name: string) => join(state.dir, "owes", `${name}.jsonl`);
      if (tail === "inbound" || tail === "intact") {
        await recordSent(state.dir, "20", "100", ["701"], 1001);
        await recordMark(state.dir, "20", "100", 1001);
        expect(openOwes(state.dir, 1002)).toEqual([]);
        if (tail === "inbound") appendFileSync(path(tail), '{"id":"torn"');
        expect(await recordOwes(state.dir, inbound("101"), 1003)).toBe(1);
        expect(openOwes(state.dir, 1004).map((owe) => owe.message)).toEqual(["101"]);
      } else {
        appendFileSync(path(tail), '{"channel":', { mode: 0o600 });
        await recordSent(state.dir, "20", "100", ["701"], 1001);
        await recordMark(state.dir, "20", "100", 1002);
        expect(openOwes(state.dir, 1003)).toEqual([]);
      }
      for (const name of ["inbound", "sent", "marks"])
        expect(readFileSync(path(name), "utf8").endsWith("\n")).toBe(true);
    } finally {
      state.done();
    }
  });
}

test("duplicates within one burst are acknowledged once", async () => {
  const state = withState();
  try {
    expect(await recordOwes(state.dir, `${inbound("100")}\n${inbound("100")}`, 1000)).toBe(1);
    expect(openOwes(state.dir, 1001)).toHaveLength(1);
  } finally {
    state.done();
  }
});

test("cancelling a contended admission rejects its exact reason without publication", async () => {
  const state = withState();
  const path = join(state.dir, "owes", "inbound.jsonl");
  mkdirSync(join(state.dir, "owes"), { recursive: true, mode: 0o700 });
  const release = takeLock(`${path}.lock`, Date.now(), (message) => new Error(message), { keepLiveOwner: true });
  if (typeof release === "string") throw new Error(release);
  const controller = new AbortController();
  const reason = new Error("admission lifecycle ended");
  const outcome = recordOwes(state.dir, inbound("100"), 1000, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(existsSync(path)).toBe(false);
  } finally {
    release();
    state.done();
  }
});

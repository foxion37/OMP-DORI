import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dutyTick } from "../src/duty.ts";
import { flushInbox, send } from "../src/inbox.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";
import { setup } from "./inbox-setup.ts";

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const REAL_WRITE = fs.writeFileSync;

afterEach(() => mock.restore());

test("send reports DELIVERED only after delivering to the destination rechecked under its route", async () => {
  const s = await quietLane();
  const next = s.w.addPane(NEW.id, "idle");
  const lane = s.d.store.lane("talker");
  if (lane === undefined) throw new Error("missing fixture lane");
  const read = s.d.store.lane.bind(s.d.store);
  let armed = true;
  spyOn(s.d.store, "lane").mockImplementation((key) => {
    const found = read(key);
    if (armed && key === lane.key) {
      armed = false;
      s.d.store.saveLane({ ...lane, sessionRef: NEW });
    }
    return found;
  });

  const result = await send(s.d, lane.key, "rechecked", "cli");

  expect({ result, delivered: next.received, old: s.pane.received }).toEqual({
    result: "DELIVERED",
    delivered: ["rechecked"],
    old: [],
  });
  expect(s.d.store.queued(NEW)).toEqual([]);
});

test("an id-less spool entry settled before an interrupted rewrite is never delivered again", async () => {
  const s = setup();
  const release = s.d.store.lockInbox(OLD, s.d.now());
  if (release === undefined) throw new Error("fixture inbox locked");
  await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "once" }, false);
  release();
  const path = s.d.store.inboxPath(OLD);
  let stopped = false;
  spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (!stopped && String(file).startsWith(path) && !String(file).endsWith(".lock")) {
      stopped = true;
      throw new Error("interrupted queue rewrite");
    }
    return REAL_WRITE(file, data, options);
  });

  await expect(flushInbox(s.d, OLD)).rejects.toThrow("interrupted queue rewrite");
  mock.restore();
  await flushInbox(s.d, OLD);

  expect(stopped).toBe(true);
  expect(s.pane.received).toEqual(["once"]);
  expect(s.d.store.queued(OLD)).toEqual([]);
});

test("enumeration during a locked partial rewrite does not abort delivery to another inbox", async () => {
  const s = setup();
  await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "rewriting" }, false);
  await s.d.store.enqueue(href("w1:p1"), { at: s.d.now(), from: "cli", text: "unrelated" }, false);
  const release = s.d.store.lockInbox(OLD, s.d.now());
  if (release === undefined) throw new Error("fixture inbox locked");
  const path = s.d.store.inboxPath(OLD);
  const bytes = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, '{"at":');
  try {
    await dutyTick(s.d);
    expect(s.lead.received).toEqual(["unrelated"]);
    expect(s.pane.received).toEqual([]);
  } finally {
    fs.writeFileSync(path, bytes);
    release();
  }
});

test("a flush that finds the queue part way through a locked rewrite waits for the holder, without throwing", async () => {
  const s = setup();
  await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "rewriting" }, false);
  const release = s.d.store.lockInbox(OLD, s.d.now());
  if (release === undefined) throw new Error("fixture inbox locked");
  const path = s.d.store.inboxPath(OLD);
  const bytes = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, '{"at":');
  try {
    expect(await flushInbox(s.d, OLD)).toBe("queued");
  } finally {
    fs.writeFileSync(path, bytes);
    release();
  }
  expect(await flushInbox(s.d, OLD)).toBe("delivered");
  expect(s.pane.received).toEqual(["rewriting"]);
});

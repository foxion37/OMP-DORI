import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Replies } from "../src/voice/replies.ts";
import { temporaryVoice } from "./voice-fixture.ts";

const line = (text: string) => `${JSON.stringify({ text })}\n`;

test("a restored reply cursor reads only appended bytes and performs no idle reads", () => {
  const tmp = temporaryVoice();
  const history = line("already spoken ".repeat(1000));
  const initial = new Replies(tmp.directory, () => {});
  fs.writeFileSync(initial.file, history);
  initial.scan();
  initial.spoken(initial.first()!);
  const replies = new Replies(tmp.directory, () => {});
  const whole = spyOn(fs, "readFileSync");
  const read = spyOn(fs, "readSync");
  try {
    replies.scan();
    expect(replies.first()).toBeUndefined();
    const next = line("\ud55c\uad6d\uc5b4 reply");
    fs.appendFileSync(replies.file, next);
    replies.scan();
    expect(replies.first()).toMatchObject({ text: "\ud55c\uad6d\uc5b4 reply", start: Buffer.byteLength(history) });
    replies.scan();
    expect(whole).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Buffer),
      0,
      Buffer.byteLength(next),
      Buffer.byteLength(history),
    );
  } finally {
    whole.mockRestore();
    read.mockRestore();
    tmp.cleanup();
  }
});

test("queued unspoken replies keep their order while only the new suffix is read", () => {
  const tmp = temporaryVoice();
  const replies = new Replies(tmp.directory, () => {});
  const history = line("first") + line("second");
  fs.writeFileSync(replies.file, history);
  replies.scan();
  const first = replies.first()!;
  const read = spyOn(fs, "readSync");
  try {
    const next = line("third");
    fs.appendFileSync(replies.file, next);
    replies.scan();
    expect(replies.first()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Buffer),
      0,
      Buffer.byteLength(next),
      Buffer.byteLength(history),
    );
    replies.spoken(first);
    expect(replies.first()?.text).toBe("second");
    replies.spoken(replies.first()!);
    expect(replies.first()?.text).toBe("third");
  } finally {
    read.mockRestore();
    tmp.cleanup();
  }
});

test("an incomplete UTF-8 line is retained without rereading it on idle ticks", () => {
  const tmp = temporaryVoice();
  const replies = new Replies(tmp.directory, () => {});
  const text = "\ud55c\uad6d\uc5b4 reply";
  const bytes = Buffer.from(line(text));
  const split = bytes.indexOf(Buffer.from("\ud55c")) + 1;
  fs.writeFileSync(replies.file, bytes.subarray(0, split));
  replies.scan();
  expect(replies.first()).toBeUndefined();
  const whole = spyOn(fs, "readFileSync");
  const read = spyOn(fs, "readSync");
  try {
    replies.scan();
    expect(whole).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    fs.appendFileSync(replies.file, bytes.subarray(split));
    replies.scan();
    expect(replies.first()).toMatchObject({ text, start: 0 });
    expect(read).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, bytes.length - split, split);
  } finally {
    whole.mockRestore();
    read.mockRestore();
    tmp.cleanup();
  }
});

test("copy-truncation below the read cursor resets queued replies and an incomplete tail", () => {
  const tmp = temporaryVoice();
  const logs: string[] = [];
  const replies = new Replies(tmp.directory, (message) => logs.push(message));
  try {
    fs.writeFileSync(replies.file, `${line("old")}{"text":"${"unfinished ".repeat(100)}`);
    replies.scan();
    const old = replies.first()!;
    const inode = fs.statSync(replies.file).ino;
    const replacement = "replacement ".repeat(10);
    fs.writeFileSync(replies.file, line(replacement)); // same inode; still larger than the complete-line cursor
    expect(fs.statSync(replies.file).ino).toBe(inode);
    replies.scan();
    replies.spoken(old);
    expect(replies.first()).toMatchObject({ text: replacement, start: 0 });
    expect(logs).toEqual([]);
  } finally {
    tmp.cleanup();
  }
});

test("short positional reads are completed without losing or duplicating a reply", () => {
  const tmp = temporaryVoice();
  const replies = new Replies(tmp.directory, () => {});
  fs.writeFileSync(replies.file, line("whole reply"));
  const original = fs.readSync;
  const read = spyOn(fs, "readSync").mockImplementationOnce((fd, buffer) => original(fd, buffer, 0, 3, 0));
  try {
    replies.scan();
    expect(replies.first()?.text).toBe("whole reply");
    expect(read).toHaveBeenCalledTimes(2);
    replies.spoken(replies.first()!);
    expect(replies.first()).toBeUndefined();
    replies.scan();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    tmp.cleanup();
  }
});

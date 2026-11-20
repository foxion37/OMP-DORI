import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../../skills/dori-mode/scripts/src/checkpoint-lock";
import { openOwes, recordOwes } from "../../skills/dori-mode/scripts/src/owes";
import { Monitors } from "../monitor";
import { readMonitorOutput } from "../monitor-output";
import { until } from "./fake-pi";

const inbound = (id: string) => `INBOUND discord 20 ${id} from=owner ref=- "question"`;
// These are real pipe/lifetime integrations; a fake clock cannot keep or terminate the child process.
const command = (text: string) => [
  process.execPath,
  "--eval",
  `console.log(${JSON.stringify(text)});setInterval(()=>{},1000)`,
];

test("line callbacks backpressure the stream rather than queueing a Promise per line", async () => {
  let pulled = 0;
  let delivered = 0;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 100) return controller.close();
      pulled++;
      controller.enqueue(new TextEncoder().encode("hit\n"));
    },
  });
  const work = readMonitorOutput(
    stream,
    async () => {
      if (++delivered === 1) {
        entered.resolve();
        await resume.promise;
      }
    },
    () => {},
    () => false,
  );
  try {
    await entered.promise;
    expect(delivered).toBe(1);
    expect(pulled).toBeLessThanOrEqual(2);
  } finally {
    resume.resolve();
    await work;
  }
  expect(delivered).toBe(100);
});

test("real child batches remain serialized and bounded while delivery waits", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const messages: string[] = [];
  let active = 0;
  let peak = 0;
  const monitors = new Monitors(
    async (text, delivery) => {
      peak = Math.max(peak, ++active);
      try {
        entered.resolve();
        await resume.promise;
        if (delivery.isCurrent()) messages.push(text);
      } finally {
        active--;
      }
    },
    () => "s1",
    10,
  );
  const code = `await Bun.write(Bun.stdout, Array.from({length:500},()=>"hit "+"x".repeat(1024)).join("\\n")+"\\n");`;
  try {
    monitors.start("burst", [process.execPath, "--eval", code], ".", "/", "s1");
    await entered.promise;
    expect([messages.length, peak]).toEqual([0, 1]);
    resume.resolve();
    await until(() => messages.join("\n").includes("monitor exited"));
    expect(
      messages
        .join("\n")
        .split("\n")
        .filter((line) => line.startsWith("[burst] hit")),
    ).toHaveLength(500);
    expect(peak).toBe(1);
    for (const message of messages) {
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(64 * 1024);
      expect(message.split("\n").length).toBeLessThanOrEqual(100);
    }
  } finally {
    resume.resolve();
    monitors.stopAll();
  }
});

for (const ending of ["switch", "shutdown", "same-id restart"] as const) {
  test(`${ending} aborts the old generation before it can publish or wake`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-dori-admission-"));
    mkdirSync(join(root, "owes"), { mode: 0o700 });
    let release: (() => void) | undefined;
    const held = takeLock(join(root, "owes", "inbound.jsonl.lock"), Date.now(), (m) => new Error(m));
    if (typeof held === "string") throw new Error(held);
    release = held;
    const entered = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const messages: string[] = [];
    let session: string | undefined = "s1";
    const monitors = new Monitors(
      async (text, delivery) => {
        entered.resolve();
        try {
          await recordOwes(root, text, Date.now(), delivery.signal);
          if (delivery.isCurrent()) messages.push(text);
        } finally {
          retired.resolve();
        }
      },
      () => session,
      10,
    );
    try {
      monitors.start("old", command(inbound("100")), "^INBOUND", "/", "s1");
      await entered.promise;
      const heartbeat = Promise.withResolvers<void>();
      setImmediate(heartbeat.resolve);
      await heartbeat.promise;
      expect(messages).toEqual([]);
      monitors.stopAll();
      session = ending === "switch" ? "s2" : ending === "shutdown" ? undefined : "s1";
      await retired.promise;
      expect(openOwes(root, Date.now())).toEqual([]);
      release();
      release = undefined;
      if (ending !== "shutdown") {
        monitors.start("new", command(inbound("101")), "^INBOUND", "/", session!);
        await until(() => messages.length > 0);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("20 101 from=owner");
        expect(openOwes(root, Date.now()).map((owe) => owe.message)).toEqual(["101"]);
      } else {
        await Promise.resolve();
        expect(messages).toEqual([]);
      }
    } finally {
      monitors.stopAll();
      release?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a timer-driven delivery rejection stops its child, reports failure and leaks no rejection", async () => {
  const messages: string[] = [];
  const leaked: unknown[] = [];
  const rejected = (error: unknown) => {
    leaked.push(error);
  };
  process.on("unhandledRejection", rejected);
  let calls = 0;
  const monitors = new Monitors(
    async (text) => {
      if (++calls === 1) {
        await Promise.resolve();
        throw new Error("fixture admission storage failed");
      }
      messages.push(text);
    },
    () => "s1",
    10,
  );
  try {
    monitors.start("failure", command("hit"), ".", "/", "s1");
    await until(() => messages.length > 0);
    expect(messages.join("\n")).toContain("fixture admission storage failed");
    expect(messages.join("\n")).toContain("raw output may be incomplete");
    expect(monitors.list()).toEqual([]);
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(leaked).toEqual([]);
  } finally {
    monitors.stopAll();
    process.removeListener("unhandledRejection", rejected);
  }
});

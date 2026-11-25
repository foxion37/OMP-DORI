import { afterEach, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discordInboundQueue,
  type DiscordInboundQueue,
} from "../../skills/cataly-mode/scripts/src/messenger/discord-inbound-queue.ts";
import { openDiscordAskMailbox } from "../../skills/cataly-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { headReceipt } from "../head-receipt.ts";
import { takeLock } from "../../skills/cataly-mode/scripts/src/checkpoint-lock.ts";
import { openOwes } from "../../skills/cataly-mode/scripts/src/owes.ts";
import { until } from "./fake-pi.ts";

const posix = test.skipIf(typeof process.getuid !== "function");
// The public CLI hands Discord intake to the Rust monitor; these cases need its binary.
const nativeBinary = process.env["CATALY_DISCORD_NATIVE_BIN"] && process.env["CATALY_DISCORD_NATIVE_BIN"] !== "off";
const nativeCli = test.skipIf(typeof process.getuid !== "function" || !nativeBinary);

type Event = {
  event: string;
  file?: string;
  sourcePid?: number;
  pending?: number;
  unresolved?: string;
  entry?: string;
  published?: boolean;
  streaming?: boolean;
  content?: string;
  details?: { ompCatalyAdmission: { identity: string; fingerprint: string } };
};
type Head = {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  events: Event[];
  observers: Set<(event: Event) => void>;
  exitFile: string;
  stderr: Promise<string>;
};
const heads: Head[] = [];
const roots: string[] = [];
const fixture = fileURLToPath(new URL("../../test/fixtures/omp-native-host/head-admission.ts", import.meta.url));
const watchers = new Set<FSWatcher>();
const event = (head: Head, name: string): Promise<Event> => {
  const received = head.events.find((item) => item.event === name);
  if (received) return Promise.resolve(received);
  return new Promise((resolve, reject) => {
    const observer = (item: Event) => {
      if (item.event !== name) return;
      head.observers.delete(observer);
      resolve(item);
    };
    head.observers.add(observer);
    void head.proc.exited.then(async (code) => {
      if (head.observers.delete(observer)) reject(new Error(["native head exited", code, await head.stderr].join(" ")));
    });
  });
};
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "cataly-head-admission-"));
  mkdirSync(join(dir, "queue"), { mode: 0o700 });
  roots.push(dir);
  return dir;
};
const start = (dir: string, mode: string, routingBinary = process.env["CATALY_DISCORD_NATIVE_BIN"]): Head => {
  const events: Event[] = [];
  const observers = new Set<(event: Event) => void>();
  const exitFile = join(dir, `source-exit-${heads.length}`);
  const proc = Bun.spawn([process.execPath, fixture, dir, mode, exitFile], {
    env: {
      ...process.env,
      HOME: dir,
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      CATALY_DISCORD_NATIVE_BIN: routingBinary,
      // The monitored CLI always gets the real monitor, even when the supervisor's router is made unavailable.
      CATALY_TEST_MONITOR_NATIVE_BIN: process.env["CATALY_DISCORD_NATIVE_BIN"],
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    serialization: "json",
    ipc: (message: unknown) => {
      const item = message as Event;
      events.push(item);
      for (const observer of observers) observer(item);
    },
  });
  const head = { proc, events, observers, exitFile, stderr: new Response(proc.stderr).text() };
  heads.push(head);
  return head;
};
const sourceExited = async (head: Head, code: number) => {
  await event(head, "ready");
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(head.exitFile), () => {
      if (!existsSync(head.exitFile) || readFileSync(head.exitFile, "utf8").length === 0) return;
      watcher.close();
      watchers.delete(watcher);
      resolve();
    });
    watchers.add(watcher);
    watcher.once("error", reject);
    if (existsSync(head.exitFile) && readFileSync(head.exitFile, "utf8").length > 0) {
      watcher.close();
      watchers.delete(watcher);
      resolve();
    }
  });
  expect(readFileSync(head.exitFile, "utf8")).toBe(String(code));
};
const stop = async (head: Head) => {
  if (head.proc.exitCode === null && head.proc.signalCode === null) head.proc.send({ op: "stop" });
  expect(await head.proc.exited).toBe(0);
  expect(await head.stderr).toBe("");
};
const queued = <T>(dir: string, inspect: (queue: DiscordInboundQueue) => T): T => {
  const queue = discordInboundQueue(join(dir, "queue"));
  try {
    return inspect(queue);
  } finally {
    queue.close();
  }
};
const sources = (head: Head) =>
  head.events.flatMap((event) => (event.details ? [event.details.ompCatalyAdmission] : []));
const pending = (dir: string, first: string | null, cursor: string) =>
  queued(dir, (queue) => {
    const source = queue.first();
    expect(source ? (source.kind === "message" ? JSON.parse(source.payload).id : source.kind) : null).toBe(first);
    expect(queue.storeFor("20").load()).toBe(cursor);
  });

afterEach(async () => {
  for (const watcher of watchers) watcher.close();
  watchers.clear();
  for (const head of heads.splice(0)) {
    if (head.proc.exitCode === null && head.proc.signalCode === null) {
      head.proc.send({ op: "stop" });
      await head.proc.exited;
    }
    const errors = await head.stderr;
    if (errors) console.error(errors);
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

nativeCli(
  "public CLI one-shot exits after native receipt and keeps context in the admitted group",
  async () => {
    const dir = root();
    const head = start(dir, "cli");
    const exited = await event(head, "source-exited");
    expect(exited.content).toContain("[source] monitor exited (code 0):");
    expect(sources(head).map((source) => source.identity)).toEqual(["99:10:20:101"]);
    const delivered = head.events.find((item) => item.event === "handoff")!;
    expect(delivered.content).toContain("[source] INBOUND discord 20 101 from=owner");
    expect(delivered.content).toContain("[source] INBOUND_CONTEXT discord 20 101");
    const source = sources(head)[0]!;
    expect(
      (
        await headReceipt(
          head.events.find((item) => item.event === "ready")!.file!,
          source.identity,
          source.fingerprint,
        )
      )?.receipt,
    ).toBe(delivered.entry);
    queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toBeNull());
    pending(dir, null, "102");
    await stop(head);
  },
  15000,
);

test.skipIf(process.platform !== "linux" || !nativeBinary)(
  "supervised Discord routes ASK and head through one Rust child",
  async () => {
    const dir = root();
    const mailbox = openDiscordAskMailbox(join(dir, "queue"), "20", "95", "10");
    const head = start(dir, "cli-shared");
    const { sourcePid } = await event(head, "ready");
    expect(typeof sourcePid).toBe("number");
    const handoff = await event(head, "handoff");
    expect(handoff.content).toContain("regular head request");
    expect(sources(head).map((source) => source.identity)).toEqual(["99:10:20:102"]);
    expect(mailbox.replies(new Set())).toEqual([{ id: "101", text: "answer to the pending ASK" }]);

    const processes = Bun.spawnSync(["ps", "-axo", "ppid=,args="]);
    expect(processes.exitCode).toBe(0);
    const routers = processes.stdout
      .toString()
      .trim()
      .split("\n")
      .flatMap((line) => {
        const row = line.trim().match(/^(\d+)\s+.*\/cataly routing$/);
        const parent = Number(row?.[1]);
        return parent === head.proc.pid || parent === sourcePid ? [parent] : [];
      });
    expect(routers).toEqual([head.proc.pid]);
    await stop(head);
  },
  15000,
);

nativeCli(
  "an unavailable shared router holds the original ASK and a fresh supervisor can finish it",
  async () => {
    const dir = root();
    const mailbox = openDiscordAskMailbox(join(dir, "queue"), "20", "95", "10");
    const failed = start(dir, "cli-shared", join(dir, "missing-cataly"));
    const exited = await event(failed, "source-exited");
    expect(exited.content).toContain("[source] monitor exited (code 1):");
    expect(sources(failed)).toEqual([]);
    expect(mailbox.replies(new Set())).toEqual([]);
    pending(dir, null, "100");
    await stop(failed);

    const recovered = start(dir, "cli-shared");
    expect((await event(recovered, "handoff")).content).toContain("regular head request");
    expect(mailbox.replies(new Set())).toEqual([{ id: "101", text: "answer to the pending ASK" }]);
    expect(sources(recovered).map(({ identity }) => identity)).toEqual(["99:10:20:102"]);
    await stop(recovered);
  },
  15000,
);

nativeCli(
  "default public REST exits nonzero when the native event has no durable receipt",
  async () => {
    const dir = root();
    const head = start(dir, "cli-unproven");
    const exited = await event(head, "source-exited");
    expect(exited.content).toContain("[source] monitor exited (code 1):");
    expect(sources(head).map((source) => source.identity)).toEqual(["99:10:20:101"]);
    queued(dir, (queue) => {
      expect(queue.unresolved()?.identity).toBe("99:10:20:101");
      expect(JSON.parse(queue.unresolved()!.source).message).toBe("101");
      expect(queue.storeFor("20").load()).toBe("100");
    });
    expect(head.events.some((item) => item.unresolved === "99:10:20:101")).toBe(true);
    await stop(head);
  },
  15000,
);

posix(
  "canceling a source releases its serial wait but does not permit live-head abandonment or redelivery",
  async () => {
    const dir = root();
    const head = start(dir, "held");
    await event(head, "handoff");
    head.proc.send({ op: "cancel-admission" });
    await event(head, "source-exited");
    queued(dir, (queue) =>
      expect(() => queue.abandon("99:10:20:101", "operator decision")).toThrow("Original head is alive"),
    );
    head.exitFile = join(dir, "restart-exit");
    head.proc.send({ op: "restart-source" });
    await sourceExited(head, 1);
    expect(sources(head).map((source) => source.identity)).toEqual(["99:10:20:101"]);
    expect(head.events.filter((item) => item.unresolved === "99:10:20:101")).toHaveLength(2);
    expect(head.events.findLast((item) => item.event === "admission-status")?.pending).toBe(0);
    pending(dir, "101", "100");
    await stop(head);
  },
  15000,
);

posix(
  "head absence retains raw FIFO input; restart and source redelivery admit each original once",
  async () => {
    const dir = root();
    const absent = start(dir, "absent");
    await sourceExited(absent, 1);
    pending(dir, "101", "100");
    expect(sources(absent)).toEqual([]);
    await stop(absent);
    const resumed = start(dir, "accepted");
    await sourceExited(resumed, 0);
    expect(sources(resumed).map((source) => source.identity)).toEqual(["99:10:20:101", "99:10:20:102"]);
    pending(dir, null, "102");
    for (const source of sources(resumed)) {
      expect(
        (
          await headReceipt(
            resumed.events.find((item) => item.event === "ready")!.file!,
            source.identity,
            source.fingerprint,
          )
        )?.outcome,
      ).toBe("accepted");
      queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toBeNull());
    }
    await stop(resumed);
  },
  15000,
);

posix(
  "a killed head after native persistence is reconciled without redispatch after lost ACK",
  async () => {
    const dir = root();
    const first = start(dir, "lost-ack");
    await event(first, "handoff");
    const source = sources(first)[0]!;
    const originalEntry = first.events.find((event) => event.event === "handoff")!.entry;
    const originalFile = first.events.find((item) => item.event === "ready")!.file!;
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    await sourceExited(first, 1);
    pending(dir, "101", "100");
    queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)?.outcome).toBe("unresolved"));
    const resumed = start(dir, "accepted");
    await sourceExited(resumed, 0);
    expect(sources(resumed).map((item) => item.identity)).toEqual(["99:10:20:102"]);
    pending(dir, null, "102");
    expect((await headReceipt(originalFile, source.identity, source.fingerprint))?.receipt).toBe(originalEntry);
    queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toBeNull());
    await stop(resumed);
  },
  15000,
);

posix.each(["held", "backfill-held"])(
  "an unproven %s handoff fences later input even after history deletion",
  async (mode) => {
    const dir = root();
    const first = start(dir, mode);
    await event(first, "handoff");
    expect(first.events.findLast((item) => item.event === "admission-status")?.pending).toBe(1);
    const source = sources(first)[0]!;
    const originalFile = first.events.find((event) => event.event === "ready")!.file!;
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    await sourceExited(first, 1);
    expect(await headReceipt(originalFile, source.identity, source.fingerprint)).toBeUndefined();
    const resumed = start(dir, mode === "backfill-held" ? "backfill-deleted" : "accepted");
    await sourceExited(resumed, 1);
    expect(sources(resumed)).toEqual([]);
    pending(dir, mode === "backfill-held" ? "sync" : "101", "100");
    queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)?.outcome).toBe("unresolved"));
    await stop(resumed);
  },
  15000,
);

posix(
  "standalone stdout cannot settle an earlier native attempt",
  async () => {
    const dir = root();
    const first = start(dir, "held");
    await event(first, "handoff");
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    await sourceExited(first, 1);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent") };
    delete env.CATALY_MONITOR_ADMISSION;
    const source = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "record-head-inbound.ts"),
        join(dir, "queue"),
        join(dir, "standalone-exit"),
      ],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(await source.exited).toBe(1);
    expect(await new Response(source.stdout).text()).not.toContain("INBOUND");
    expect(await new Response(source.stderr).text()).toContain("HEAD_ADMISSION_UNRESOLVED");
    pending(dir, "101", "100");
  },
  15000,
);

posix(
  "explicit abandonment of a killed native head resumes later input without resending the original",
  async () => {
    const dir = root();
    const first = start(dir, "held");
    await event(first, "handoff");
    const source = sources(first)[0]!;
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    await sourceExited(first, 1);
    const decision = queued(dir, (queue) =>
      queue.abandon(source.identity, "Owner explicitly forgoes this unconfirmed input"),
    );
    expect(decision.headPid).toBe(first.proc.pid);
    expect(decision.outcome).toBe("abandoned");
    expect(JSON.parse(decision.source).text).toBe("owner 101");
    const resumed = start(dir, "accepted");
    await sourceExited(resumed, 0);
    expect(sources(resumed).map((item) => item.identity)).toEqual(["99:10:20:102"]);
    pending(dir, null, "102");
    queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toEqual(decision));
    await stop(resumed);
  },
  15000,
);

posix(
  "an explicit monitor rejection has a native receipt and advances FIFO without delivery",
  async () => {
    const dir = root();
    const head = start(dir, "filtered");
    await sourceExited(head, 0);
    expect(sources(head)).toEqual([]);
    pending(dir, null, "102");
    const file = head.events.find((event) => event.event === "ready")!.file!;
    const entries = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const rejected = entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "omp-cataly:admission-rejected",
    );
    expect(rejected).toHaveLength(2);
    for (const entry of rejected) {
      const source = entry.data.ompCatalyAdmission;
      expect(await headReceipt(file, source.identity, source.fingerprint)).toEqual({
        outcome: "rejected",
        receipt: entry.id,
      });
      queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toBeNull());
    }
    await stop(head);
  },
  15000,
);

posix(
  "real AgentSession admits an idle aside and a streaming aside through native message_end",
  async () => {
    const dir = root();
    const head = start(dir, "agent");
    await sourceExited(head, 0);
    expect(head.events.filter((item) => item.event === "native-send").map((item) => item.streaming)).toEqual([
      false,
      true,
    ]);
    const delivered = head.events.filter((item) => item.event === "native-message-end");
    expect(delivered.map((item) => item.details?.ompCatalyAdmission.identity)).toEqual([
      "99:10:20:101",
      "99:10:20:102",
    ]);
    const file = head.events.find((item) => item.event === "ready")!.file!;
    for (const item of delivered) {
      const source = item.details!.ompCatalyAdmission;
      expect((await headReceipt(file, source.identity, source.fingerprint))?.outcome).toBe("accepted");
      queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toBeNull());
    }
    pending(dir, null, "102");
    await stop(head);
    const entries = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
  },
  30000,
);

posix(
  "message_end during a native atomic batch publishes the deferred entry before judging admission",
  async () => {
    const dir = root();
    const head = start(dir, "atomic-batch");
    await sourceExited(head, 0);
    const handoffs = head.events.filter((item) => item.event === "handoff");
    expect(handoffs.map((item) => item.details?.ompCatalyAdmission.identity)).toEqual(["99:10:20:101", "99:10:20:102"]);
    // Each native entry was still unpublished when its message_end was judged.
    expect(handoffs.map((item) => item.published)).toEqual([false, false]);
    expect(head.events.filter((item) => item.unresolved !== undefined)).toEqual([]);
    const file = head.events.find((item) => item.event === "ready")!.file!;
    for (const handoff of handoffs) {
      const source = handoff.details!.ompCatalyAdmission;
      expect(await headReceipt(file, source.identity, source.fingerprint)).toEqual({
        outcome: "accepted",
        receipt: handoff.entry!,
      });
      queued(dir, (queue) => expect(queue.admission(source.identity, source.fingerprint)).toBeNull());
    }
    const batches = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "custom" && entry.customType === "omp-cataly:fixture-batch");
    expect(batches).toHaveLength(2);
    pending(dir, null, "102");
    await stop(head);
  },
  15000,
);

const holdOwes = (dir: string) => {
  const folder = join(dir, "queue", "owes");
  mkdirSync(folder, { mode: 0o700 });
  const release = takeLock(join(folder, "inbound.jsonl.lock"), Date.now(), (message) => new Error(message));
  if (typeof release === "string") throw new Error(release);
  return release;
};

posix(
  "native receipt delivery waits behind an ordinary owe admission and preserves FIFO",
  async () => {
    const dir = root();
    const release = holdOwes(dir);
    const head = start(dir, "owes-serial");
    let held = true;
    try {
      await event(head, "ready");
      expect((await event(head, "admission-status")).pending).toBe(1);
      const waiting = head.events.filter((item) => item.event === "before-owe");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.content).toContain("[prior] INBOUND discord 20 90");
      expect(sources(head)).toEqual([]);
      expect(openOwes(join(dir, "queue"), Date.now())).toEqual([]);
      release();
      held = false;
      await sourceExited(head, 0);
      const admitted = head.events.filter((item) => item.event === "owe-admitted");
      expect(admitted.map((item) => item.details?.ompCatalyAdmission.identity ?? "prior")).toEqual([
        "prior",
        "99:10:20:101",
        "99:10:20:102",
      ]);
      expect(openOwes(join(dir, "queue"), Date.now()).map((owe) => owe.message)).toEqual(["90", "101", "102"]);
      const handoffs = head.events.filter((item) => item.event === "handoff");
      expect(handoffs.map((item) => item.details?.ompCatalyAdmission.identity)).toEqual([
        "99:10:20:101",
        "99:10:20:102",
      ]);
      for (const item of handoffs) {
        const source = item.details!.ompCatalyAdmission;
        expect(
          (
            await headReceipt(
              head.events.find((item) => item.event === "ready")!.file!,
              source.identity,
              source.fingerprint,
            )
          )?.receipt,
        ).toBe(item.entry);
      }
      pending(dir, null, "102");
      await stop(head);
    } finally {
      if (held) release();
    }
  },
  15000,
);

posix(
  "source cancellation releases receipt status while asynchronous owe delivery is still blocked",
  async () => {
    const dir = root();
    const release = holdOwes(dir);
    const head = start(dir, "owes-locked");
    try {
      await event(head, "ready");
      await event(head, "before-owe");
      head.proc.send({ op: "cancel-admission" });
      await until(() => head.events.findLast((item) => item.event === "admission-status")?.pending === 0);
      await sourceExited(head, 1);
      expect(head.events.filter((item) => item.event === "handoff")).toEqual([]);
      expect(openOwes(join(dir, "queue"), Date.now())).toEqual([]);
      pending(dir, "101", "100");
      queued(dir, (queue) => expect(queue.unresolved()?.identity).toBe("99:10:20:101"));
      await stop(head);
    } finally {
      release();
    }
  },
  15000,
);

posix(
  "session cancellation during native owe admission leaves no publication and retains the original fence",
  async () => {
    const dir = root();
    const release = holdOwes(dir);
    const head = start(dir, "owes-locked");
    let held = true;
    try {
      const ready = await event(head, "ready");
      expect((await event(head, "before-owe")).details?.ompCatalyAdmission.identity).toBe("99:10:20:101");
      head.proc.send({ op: "stop-monitors" });
      await event(head, "monitors-stopped");
      await until(() => {
        try {
          process.kill(ready.sourcePid!, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      });
      await until(() => head.events.findLast((item) => item.event === "admission-status")?.pending === 0);
      release();
      held = false;
      expect(head.events.filter((item) => item.event === "owe-admitted" || item.event === "handoff")).toEqual([]);
      expect(openOwes(join(dir, "queue"), Date.now())).toEqual([]);
      queued(dir, (queue) => expect(queue.unresolved()?.identity).toBe("99:10:20:101"));
      pending(dir, "101", "100");
      await stop(head);
      const resumed = start(dir, "accepted");
      await sourceExited(resumed, 1);
      expect(sources(resumed)).toEqual([]);
      pending(dir, "101", "100");
      await stop(resumed);
    } finally {
      if (held) release();
    }
  },
  15000,
);

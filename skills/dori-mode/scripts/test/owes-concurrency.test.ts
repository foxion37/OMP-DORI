import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openOwes, recordOwes } from "../src/owes.ts";
import { withState } from "./fakes.ts";

const moduleUrl = new URL("../src/owes.ts", import.meta.url).href;
const lockUrl = new URL("../src/checkpoint-lock.ts", import.meta.url).href;
const line = (id: string, channel = "20") => `INBOUND discord ${channel} ${id} from=owner ref=- "question"`;

/** Every real child reaches READY before any receives permission to invoke the imported writer. */
const race = async (stateDir: string, mode: "distinct" | "duplicate" | "receipts") => {
  const children = Array.from({ length: 16 }, (_, index) => {
    const id = mode === "duplicate" ? "2000" : String(2000 + index);
    const code = `
      import { recordOwes, recordSent, recordMark } from ${JSON.stringify(moduleUrl)};
      console.log("READY");
      if ((await Bun.stdin.text()).trim() !== "GO") throw new Error("writer barrier was not released");
      const root = ${JSON.stringify(stateDir)};
      ${
        mode === "receipts"
          ? `await recordSent(root, "${3000 + index}", "${id}", ["${4000 + index}"], 1001); await recordMark(root, "${3000 + index}", "${id}", 1002); console.log(1);`
          : `console.log(await recordOwes(root, ${JSON.stringify(line(id))}, 1000));`
      }
    `;
    return Bun.spawn([process.execPath, "--eval", code], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  });
  try {
    const streams = await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) throw new Error("writer ended before READY");
          buffer += decoder.decode(part.value, { stream: true });
          const end = buffer.indexOf("\n");
          if (end < 0) continue;
          expect(buffer.slice(0, end).trim()).toBe("READY");
          return { child, reader, decoder, tail: buffer.slice(end + 1) };
        }
      }),
    );
    for (const { child } of streams) {
      child.stdin.write("GO\n");
      child.stdin.end();
    }
    return await Promise.all(
      streams.map(async ({ child, reader, decoder, tail }) => {
        const stdout = (async () => {
          let output = tail;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              output += decoder.decode(part.value, { stream: true });
            }
            return output + decoder.decode();
          } finally {
            reader.releaseLock();
          }
        })();
        const [code, output, error] = await Promise.all([child.exited, stdout, new Response(child.stderr).text()]);
        expect([code, error]).toEqual([0, ""]);
        return Number(output.trim());
      }),
    );
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
};

for (const mode of ["distinct", "duplicate"] as const) {
  test(`200-row concurrent ${mode} admissions preserve every acknowledged new ID`, async () => {
    const state = withState();
    try {
      await recordOwes(state.dir, Array.from({ length: 200 }, (_, i) => line(String(i))).join("\n"), 1000);
      const counts = await race(state.dir, mode);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(mode === "distinct" ? 16 : 1);
      const records = readFileSync(join(state.dir, "owes", "inbound.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(records).toHaveLength(200);
      const ids = openOwes(state.dir, 1003).map((owe) => owe.message);
      for (let i = 0; i < (mode === "distinct" ? 16 : 1); i++) expect(ids).toContain(String(2000 + i));
      if (mode === "duplicate") expect(ids.filter((id) => id === "2000")).toHaveLength(1);
    } finally {
      state.done();
    }
  }, 15_000);
}

test("200-row concurrent send and mark receipts all survive and settle their matching obligations", async () => {
  const state = withState();
  try {
    await recordOwes(
      state.dir,
      Array.from({ length: 16 }, (_, i) => line(String(2000 + i), String(3000 + i))).join("\n"),
      1000,
    );
    for (const name of ["sent", "marks"]) {
      const seed = Array.from({ length: 200 }, (_, i) =>
        JSON.stringify({ channel: String(i), message: String(i), at: 0 }),
      );
      writeFileSync(join(state.dir, "owes", `${name}.jsonl`), `${seed.join("\n")}\n`, { mode: 0o600 });
    }
    expect(await race(state.dir, "receipts")).toEqual(Array(16).fill(1));
    expect(openOwes(state.dir, 1003)).toEqual([]);
    for (const name of ["sent", "marks"]) {
      const records = readFileSync(join(state.dir, "owes", `${name}.jsonl`), "utf8")
        .trim()
        .split("\n");
      expect(records).toHaveLength(200);
      const channels = records.map((record) => {
        const value: unknown = JSON.parse(record);
        if (!value || typeof value !== "object" || !("channel" in value) || typeof value.channel !== "string")
          throw new Error("receipt has no channel");
        return value.channel;
      });
      for (let i = 0; i < 16; i++) expect(channels).toContain(String(3000 + i));
    }
  } finally {
    state.done();
  }
}, 15_000);

test("a real dead writer's lock is reclaimed before admitting the next owe", async () => {
  const state = withState();
  mkdirSync(join(state.dir, "owes"), { recursive: true, mode: 0o700 });
  const code = `
    import { takeLock } from ${JSON.stringify(lockUrl)};
    const held = takeLock(${JSON.stringify(join(state.dir, "owes", "inbound.jsonl.lock"))}, Date.now(), m => new Error(m), {keepLiveOwner:true});
    if (typeof held === "string") throw new Error(held);
    console.log("READY");
    await Bun.stdin.text();
  `;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("READY");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    expect(await recordOwes(state.dir, line("2000"), 1000)).toBe(1);
    expect(openOwes(state.dir, 1001).map((owe) => owe.message)).toEqual(["2000"]);
  } finally {
    child.kill();
    await child.exited;
    state.done();
  }
});

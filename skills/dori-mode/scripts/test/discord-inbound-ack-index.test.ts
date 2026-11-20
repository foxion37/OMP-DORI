import { expect, test } from "bun:test";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

posix("exact acknowledgement seeks the full channel and snowflake index without removing another channel", () => {
  const state = withState();
  const source = new URL("../src/messenger/discord-inbound-queue.ts", import.meta.url).href;
  const script = `
    import { Database } from "bun:sqlite";
    import { discordInboundQueue } from ${JSON.stringify(source)};
    const nativeQuery = Database.prototype.query;
    let executed = [];
    Database.prototype.query = function(sql, ...args) {
      const database = this;
      const statement = nativeQuery.call(database, sql, ...args);
      const nativeRun = statement.run;
      statement.run = function(...bindings) {
        executed.push({ database, sql, bindings });
        return nativeRun.apply(statement, bindings);
      };
      return statement;
    };
    let queue;
    try { queue = discordInboundQueue(process.env.DORI_TEST_QUEUE_STATE); }
    finally { Database.prototype.query = nativeQuery; }
    try {
      for (let id = 1; id <= 2000; id++)
        queue.push("message", { id: String(id), channel_id: "20", type: 0, author: { id: "10" }, content: "fixture" }, "0");
      queue.push("message", { id: "105", channel_id: "20", type: 0, author: { id: "10" }, content: "duplicate" }, "0");
      queue.push("message", { id: "105", channel_id: "21", type: 0, author: { id: "10" }, content: "other channel" }, "0");
      executed = [];
      queue.acknowledge("20", "105");
      if (executed.length !== 1) throw new Error("Expected one actual prepared acknowledgement execution");
      const [{ database, sql, bindings }] = executed;
      const plan = database.query("EXPLAIN QUERY PLAN " + sql).all(...bindings);
      const remaining = database.query("SELECT count(*) AS count FROM pending").get().count;
      const copies = database.query("SELECT json_extract(payload, '$.channel_id') AS channel FROM pending WHERE json_extract(payload, '$.id') = '105'").all();
      console.log(JSON.stringify({ plan, remaining, copies, bindings }));
    } finally { queue.close(); }
  `;
  try {
    const result = Bun.spawnSync([process.execPath, "--no-install", "--eval", script], {
      env: { DORI_TEST_QUEUE_STATE: state.dir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString());
    const { plan, remaining, copies, bindings } = JSON.parse(Buffer.from(result.stdout).toString());
    const detail = plan.map((row: { detail: string }) => row.detail).join("\n");
    expect(detail).toContain("pending_channel");
    expect((detail.match(/<expr>=\?/g) ?? []).length).toBe(3);
    expect(bindings).toEqual(["20", 3, "105"]);
    expect(remaining).toBe(2000);
    expect(copies).toEqual([{ channel: "21" }]);
  } finally {
    state.done();
  }
});

import { expect, test } from "bun:test";
import { join } from "node:path";
import { takeLock } from "../src/checkpoint-lock.ts";
import type { Http } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

test("a Slack post retains its confirmed receipt when the local ledger stays locked", async () => {
  const state = withState();
  const file = join(state.dir, "threads.json");
  const release = takeLock(`${file}.lock`, Date.now(), (message) => new Error(message));
  if (typeof release !== "function") throw new Error(release);
  try {
    let posts = 0;
    const http: Http = async ({ url }) => {
      if (url.endsWith("/auth.test"))
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true, team_id: "T1", user_id: "U1" }) };
      posts++;
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C1", ts: "71.1" }) };
    };
    const ledger = new ThreadLedger(file, async () => {});
    const error = await new Slack(http, fakeClock(0), { token: "synthetic-token" }, undefined, ledger)
      .post("C1", "already posted", "70.1")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      outcome: "confirmed",
      code: "DELIVERY_CONFIRMED_LOCAL_ERROR",
      receipt: { channel: "C1", messageId: "71.1" },
    });
    expect(String(error)).toContain("do not resend");
    expect(String(error)).toContain("C1/71.1");
    expect(String(error)).not.toContain(state.dir);
    expect(posts).toBe(1);
  } finally {
    release();
    state.done();
  }
});

test.each([{ channel: "C1", ts: "" }, { ts: "71.1" }, { channel: "", ts: "71.1" }])(
  "malformed Slack receipts remain uncertain before a locked ledger is touched: %j",
  async (receipt) => {
    const state = withState();
    const file = join(state.dir, "threads.json");
    const release = takeLock(`${file}.lock`, Date.now(), (message) => new Error(message));
    if (typeof release !== "function") throw new Error(release);
    try {
      let waits = 0;
      const ledger = new ThreadLedger(file, async () => {
        waits++;
      });
      const http: Http = async ({ url }) => ({
        status: 200,
        headers: {},
        body: JSON.stringify(
          url.endsWith("/auth.test") ? { ok: true, team_id: "T1", user_id: "U1" } : { ok: true, ...receipt },
        ),
      });
      const error = await new Slack(http, fakeClock(0), { token: "t" }, undefined, ledger)
        .post("C1", "possibly posted")
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ outcome: "uncertain", code: "DELIVERY_UNCERTAIN" });
      expect(error).not.toHaveProperty("receipt", expect.anything());
      expect(waits).toBe(0);
    } finally {
      release();
      state.done();
    }
  },
);

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { type Inbound, pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { type TestState, withState } from "./fakes.ts";
import { routeClient } from "./slack-route-fakes.ts";

const A = { teamId: "T01", userId: "U01" };
const B = { teamId: "T02", userId: "U01" };
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("each account reads and commits only its own equal-ID thread and emits its actual scope", async () => {
  const ledger = new ThreadLedger(join(state.dir, "threads.json"));
  await ledger.record(A, "C01", "1.0", "2.0");
  await ledger.record(B, "C01", "1.0", "5.0");
  const fixture = routeClient(B, {
    responses: {
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "6.0", thread_ts: "1.0", channel: "C01", user: "U_GUEST", username: "same-name", text: "reply" },
          { ts: "7.0", thread_ts: "1.0", channel: "C01", user: "U01", username: "same-name", text: "self" },
          { ts: "8.0", thread_ts: "1.0", channel: "C01", user: "U_BOT", bot_id: "B1", text: "bot" },
        ],
      },
    },
  });
  const got: Inbound[] = [];
  await pollSlackInbound(fixture.slack, ledger, {}, (message) => {
    got.push(message);
  });
  expect(got).toEqual([
    { scope: B, source: "own-thread", channel: "C01", threadTs: "1.0", ts: "6.0", user: "U_GUEST", text: "reply" },
  ]);
  const request = fixture.requests.find((r) => r.url.endsWith("conversations.replies"));
  expect(JSON.parse(String(request?.body))).toEqual({
    channel: "C01",
    ts: "1.0",
    oldest: "5.0",
    inclusive: false,
    limit: 50,
  });
  expect((await ledger.list(A)).map((t) => t.seenTs)).toEqual(["2.0"]);
  expect((await ledger.list(B)).map((t) => t.seenTs)).toEqual(["8.0"]);
});

test("a thread-view parent mismatch emits nothing and commits no account cursor", async () => {
  for (const changed of [{ thread_ts: "foreign-root" }, { channel: "C02" }]) {
    const ledger = new ThreadLedger(join(state.dir, "threads.json"));
    await ledger.record(A, "C01", "1.0", "2.0");
    const fixture = routeClient(A, {
      responses: {
        "subscriptions.thread.getView": {
          ok: true,
          threads: [
            {
              root_msg: { channel: "C01", ts: "1.0" },
              unread_replies: [{ ts: "3.0", user: "U_GUEST", text: "wrong route", ...changed }],
            },
          ],
        },
      },
    });
    const got: Inbound[] = [];
    await expect(
      pollSlackInbound(fixture.slack, ledger, {}, (message) => {
        got.push(message);
      }),
    ).rejects.toThrow("parent");
    expect(got).toEqual([]);
    expect((await ledger.list(A)).map((t) => t.seenTs)).toEqual(["2.0"]);
  }
});

test("an own-thread parent mismatch cannot advance past an undispatched message", async () => {
  for (const changed of [{ thread_ts: "foreign-root" }, { channel: "C02" }]) {
    const ledger = new ThreadLedger(join(state.dir, "threads.json"));
    await ledger.record(A, "C01", "1.0", "2.0");
    const fixture = routeClient(A, {
      responses: {
        "conversations.replies": {
          ok: true,
          messages: [
            { ts: "3.0", user: "U_GUEST", text: "valid earlier message", thread_ts: "1.0", channel: "C01" },
            { ts: "4.0", user: "U_GUEST", text: "wrong route", ...changed },
          ],
        },
      },
    });
    const got: Inbound[] = [];
    await expect(
      pollSlackInbound(fixture.slack, ledger, {}, (message) => {
        got.push(message);
      }),
    ).rejects.toThrow("parent");
    expect(got).toEqual([]);
    expect((await ledger.list(A)).map((t) => t.seenTs)).toEqual(["2.0"]);
  }
});

test("malformed timestamp identities cannot enter output or corrupt a scoped cursor", async () => {
  const ledger = new ThreadLedger(join(state.dir, "threads.json"));
  await ledger.record(A, "C01", "1.0", "2.0");
  for (const responses of [
    { "conversations.replies": { ok: true, messages: [{ ts: 3, user: "U_GUEST" }] } },
    {
      "subscriptions.thread.getView": {
        ok: true,
        threads: [{ root_msg: { channel: "C01", ts: 1 }, unread_replies: [{ ts: "3.0", user: "U_GUEST" }] }],
      },
    },
  ]) {
    const fixture = routeClient(A, { responses });
    const got: Inbound[] = [];
    await expect(
      pollSlackInbound(fixture.slack, ledger, {}, (message) => {
        got.push(message);
      }),
    ).rejects.toThrow("timestamp");
    expect(got).toEqual([]);
    expect((await ledger.list(A)).map((t) => t.seenTs)).toEqual(["2.0"]);
  }
});

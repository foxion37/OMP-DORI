import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { type Inbound, pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

const SELF = "U_DORI";
const SCOPE = { teamId: "T_TEST", userId: SELF };
const state = withState();
afterEach(() => {});

type Workspace = {
  replies: Record<string, { ts: string; user?: string; text: string; bot_id?: string }[]>;
  view: unknown[];
  counts: Record<string, unknown>;
  nextTs: number;
  /** The next call of this method answers HTTP 200 with a Slack error, once. */
  failOnce?: string;
};

const slackFake = (w: Workspace) => {
  const calls: string[] = [];
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const method = req.url.split("/").pop() ?? "";
    calls.push(method);
    if (method === w.failOnce) {
      delete w.failOnce;
      return { status: 200, headers: {}, body: JSON.stringify({ ok: false, error: "internal_error" }) };
    }
    const p = JSON.parse(String(req.body ?? "{}")) as Record<string, unknown>;
    const body = (b: unknown): HttpResponse => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true, ...(b as object) }),
    });
    if (method === "auth.test") return body({ team_id: "T_TEST", user_id: SELF });
    if (method === "chat.postMessage") {
      const ts = `${w.nextTs++}.000100`;
      const root = typeof p["thread_ts"] === "string" ? p["thread_ts"] : ts;
      const thread = `${p["channel"]}:${root}`;
      const replies = w.replies[thread] ?? [];
      w.replies[thread] = replies;
      replies.push({ ts, user: SELF, text: String(p["text"]) });
      return body({ channel: p["channel"], ts });
    }
    if (method === "conversations.replies") {
      const all = w.replies[`${p["channel"]}:${p["ts"]}`] ?? [];
      return body({ messages: all.filter((m) => Number(m.ts) > Number(p["oldest"] ?? 0)) });
    }
    if (method === "subscriptions.thread.getView") return body({ threads: w.view });
    if (method === "client.counts") return body(w.counts);
    return body({});
  };
  return { http, calls };
};

const setup = (name: string) => {
  const w: Workspace = { replies: {}, view: [], counts: { channels: [], ims: [], mpims: [] }, nextTs: 1000 };
  const { http, calls } = slackFake(w);
  const ledger = new ThreadLedger(join(state.dir, `${name}.json`));
  const slack = new Slack(http, fakeClock(0), { token: "t" }, "https://slack.test/api", ledger);
  // The receiver's view: what one poll emitted, in order.
  const poll = async (emit?: (i: Inbound) => void): Promise<Inbound[]> => {
    const got: Inbound[] = [];
    await pollSlackInbound(slack, ledger, {}, (i) => {
      emit?.(i);
      got.push(i);
    });
    return got;
  };
  return { w, slack, ledger, calls, poll };
};

test("a guest's untagged reply in a thread the Dori started through a raw API call is still picked up", async () => {
  const { w, slack, poll } = setup("raw-root");
  const root = (await slack.call("chat.postMessage", { channel: "C1", text: "Kicking off the release checklist" })) as {
    ts: string;
  };
  w.replies[`C1:${root.ts}`]?.push({ ts: "2000.000100", user: "U_GUEST", text: "the staging deploy is red" });
  const got = await poll();
  expect(got).toEqual([
    {
      scope: SCOPE,
      source: "own-thread",
      channel: "C1",
      ts: "2000.000100",
      threadTs: root.ts,
      user: "U_GUEST",
      text: "the staging deploy is red",
    },
  ]);
  expect(await poll()).toEqual([]);
});

test("a reply the Dori posts into someone else's thread also makes that thread watched, and its own messages are never inbound", async () => {
  const { w, slack, poll } = setup("reply");
  w.replies["C2:500.000100"] = [{ ts: "500.000100", user: "U_OWNER", text: "can you check this?" }];
  await slack.post("C2", "on it", "500.000100");
  w.replies["C2:500.000100"]?.push(
    { ts: "3000.000100", user: "U_OWNER", text: "thanks, also the logs" },
    { ts: "3001.000100", bot_id: "B1", user: "U_BOT", text: "automated" },
  );
  const got = await poll();
  expect(got.map((g) => [g.source, g.ts, g.user])).toEqual([["own-thread", "3000.000100", "U_OWNER"]]);
});

test("unread replies from the threads view and DMs with unreads are surfaced, each message once", async () => {
  const { w, poll } = setup("view");
  w.view = [
    {
      root_msg: { channel: "C3", ts: "10.1", user: "U_OWNER" },
      unread_replies: [
        { ts: "11.1", thread_ts: "10.1", user: "U_TEAM", text: "ping" },
        { ts: "12.1", thread_ts: "10.1", user: SELF, text: "mine" },
      ],
    },
  ];
  w.counts = {
    channels: [
      { id: "C9", has_unreads: true, mention_count: 0 },
      { id: "C8", has_unreads: true, mention_count: 2 },
    ],
    ims: [{ id: "D1", has_unreads: true, mention_count: 1 }],
    mpims: [],
  };
  const got = await poll();
  expect(got.map((g) => `${g.source}:${g.channel}:${g.ts}`)).toEqual([
    "threads-view:C3:11.1",
    "unread:D1:",
    "unread:C8:",
  ]);
});

test("the thread ledger survives a restart: a new process still watches threads posted before it", async () => {
  const a = setup("restart");
  const root = (await a.slack.post("C4", "starting the migration")).ts;
  const fresh = new ThreadLedger(join(state.dir, "restart.json"));
  expect((await fresh.list(SCOPE)).map((t) => `${t.channel}:${t.rootTs}`)).toEqual([`C4:${root}`]);
});

test("a poll that fails after reading an own-thread reply moves no cursor, so the next poll still delivers it", async () => {
  const { w, slack, poll } = setup("failed-poll");
  const root = (await slack.post("C5", "deploy plan")).ts;
  w.replies[`C5:${root}`]?.push({ ts: "2000.000100", user: "U_OWNER", text: "do not deploy" });
  const emitted: string[] = [];
  w.failOnce = "client.counts";
  await expect(poll((i) => emitted.push(i.ts))).rejects.toThrow("internal_error");
  expect(emitted).toEqual([]);
  // The consumer itself fails: the reply stays unseen as well.
  await expect(
    poll(() => {
      throw new Error("stdout closed");
    }),
  ).rejects.toThrow("stdout closed");
  expect((await poll()).map((i) => [i.source, i.ts, i.text])).toEqual([["own-thread", "2000.000100", "do not deploy"]]);
  expect(await poll()).toEqual([]);
});

test("a reply a separate `dori send slack` posts after an undelivered owner reply does not hide that reply", async () => {
  const { w, slack, poll } = setup("separate-sender");
  const root = (await slack.post("C7", "migration plan")).ts;
  w.replies[`C7:${root}`]?.push({ ts: "2000.000100", user: "U_OWNER", text: "wait for the backup" });
  // Another process, with its own ledger instance on the same file, replies before the receiver's next poll.
  w.nextTs = 3000;
  const sender = new Slack(
    slackFake(w).http,
    fakeClock(0),
    { token: "t" },
    "https://slack.test/api",
    new ThreadLedger(join(state.dir, "separate-sender.json")),
  );
  await sender.post("C7", "starting now", root);
  expect((await poll()).map((i) => [i.source, i.ts, i.text])).toEqual([
    ["own-thread", "2000.000100", "wait for the backup"],
  ]);
  expect(await poll()).toEqual([]);
});

test("a newer unread in the threads view does not skip an older unseen reply in an own thread", async () => {
  const { w, slack, poll } = setup("partial-view");
  const root = (await slack.post("C6", "release checklist")).ts;
  w.replies[`C6:${root}`]?.push(
    { ts: "2000.000100", user: "U_OWNER", text: "earlier, read on the phone" },
    { ts: "2001.000100", user: "U_OWNER", text: "newer, still unread" },
  );
  w.view = [
    {
      root_msg: { channel: "C6", ts: root },
      unread_replies: [{ ts: "2001.000100", thread_ts: root, user: "U_OWNER", text: "newer, still unread" }],
    },
  ];
  expect((await poll()).map((i) => `${i.source}:${i.ts}`)).toEqual([
    "threads-view:2001.000100",
    "own-thread:2000.000100",
  ]);
  w.view = [];
  expect(await poll()).toEqual([]);
});

test("every emit finishes before any own-thread cursor advances, including an asynchronous later failure", async () => {
  const { w, slack, ledger } = setup("emit-barrier");
  const first = (await slack.post("C8", "first thread")).ts;
  const second = (await slack.post("C9", "second thread")).ts;
  w.replies[`C8:${first}`]?.push({ ts: "3000.000100", user: "U_OWNER", text: "first reply" });
  w.replies[`C9:${second}`]?.push({ ts: "3001.000100", user: "U_OWNER", text: "second reply" });
  const before = await ledger.list(SCOPE);
  const emitted: string[] = [];
  await expect(
    pollSlackInbound(slack, ledger, {}, async (message) => {
      expect(await ledger.list(SCOPE)).toEqual(before);
      emitted.push(message.ts);
      if (emitted.length === 2) throw new Error("later consumer failed");
    }),
  ).rejects.toThrow("later consumer failed");
  expect(await ledger.list(SCOPE)).toEqual(before);
  const retried: string[] = [];
  await pollSlackInbound(slack, ledger, {}, async (message) => {
    expect(await ledger.list(SCOPE)).toEqual(before);
    retried.push(message.ts);
  });
  expect(retried).toEqual(emitted);
  expect((await ledger.list(SCOPE)).map((thread) => thread.seenTs)).toEqual(["3000.000100", "3001.000100"]);
});

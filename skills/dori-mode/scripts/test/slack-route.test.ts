import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Http } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";
import { routeClient } from "./slack-route-fakes.ts";

test("the same channel and root in different authenticated workspaces keep separate thread positions", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "slack-threads.json");
    const post = async (teamId: string, postedTs: string) => {
      const http: Http = async (request) => {
        const method = new URL(request.url).pathname.split("/").at(-1);
        const body =
          method === "auth.test"
            ? { ok: true, team_id: teamId, user_id: "U01" }
            : method === "chat.postMessage"
              ? { ok: true, channel: "C01", ts: postedTs }
              : undefined;
        if (body === undefined) throw new Error(`unexpected Slack method ${method}`);
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      };
      const slack = new Slack(
        http,
        fakeClock(0),
        { token: `fake-${teamId}` },
        "https://slack.test/api",
        new ThreadLedger(file),
      );
      await slack.post("C01", "a scoped reply", "1000.000100");
    };
    await post("T01", "1001.000100");
    await post("T02", "1002.000100");
    type Row = { scope?: { teamId: string; userId: string }; channel: string; rootTs: string; seenTs: string };
    const stored = JSON.parse(readFileSync(file, "utf8")) as Row[] | { threads: Row[] };
    const rows = Array.isArray(stored) ? stored : stored.threads;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.scope?.teamId, row.scope?.userId, row.channel, row.rootTs, row.seenTs])).toEqual([
      ["T01", "U01", "C01", "1000.000100", "1001.000100"],
      ["T02", "U01", "C01", "1000.000100", "1002.000100"],
    ]);
  } finally {
    state.done();
  }
});

const SCOPE = { teamId: "T01", userId: "U01" };

test("different authenticated users in one workspace do not share a thread cursor", async () => {
  const state = withState();
  try {
    const ledger = new ThreadLedger(join(state.dir, "threads.json"));
    const other = { ...SCOPE, userId: "U02" };
    await routeClient(SCOPE, { ledger, postedTs: "1001.000100" }).slack.post("C01", "first", "1000.000100");
    await routeClient(other, { ledger, postedTs: "1002.000100" }).slack.post("C01", "second", "1000.000100");
    expect((await ledger.list(SCOPE)).map((t) => t.seenTs)).toEqual(["1001.000100"]);
    expect((await ledger.list(other)).map((t) => t.seenTs)).toEqual(["1002.000100"]);
  } finally {
    state.done();
  }
});

test("credential rotation for the same account preserves its earlier unread position", async () => {
  const state = withState();
  try {
    const ledger = new ThreadLedger(join(state.dir, "threads.json"));
    await routeClient(SCOPE, { ledger, token: "fake-old", postedTs: "1001.000100" }).slack.post(
      "C01",
      "first",
      "1000.000100",
    );
    await routeClient(SCOPE, { ledger, token: "fake-new", postedTs: "1002.000100" }).slack.post(
      "C01",
      "later",
      "1000.000100",
    );
    expect(await ledger.list(SCOPE)).toEqual([{ channel: "C01", rootTs: "1000.000100", seenTs: "1001.000100" }]);
  } finally {
    state.done();
  }
});

test("a foreign workspace or account is refused before post, edit, raw completion or upload allocation", async () => {
  for (const target of ["slack:T02:U01:C01", "slack:T01:U02:C01"]) {
    for (const action of ["post", "edit", "complete", "upload"]) {
      const fixture = routeClient(SCOPE);
      const send =
        action === "post"
          ? () => fixture.slack.post(target, "reply", "1000.000100")
          : action === "edit"
            ? () => fixture.slack.edit(target, "1001.000100", "edited")
            : action === "complete"
              ? () => fixture.slack.call("files.completeUploadExternal", { channel_id: target })
              : () => fixture.slack.upload(target, "example.txt", new Uint8Array([1]));
      await expect(send()).rejects.toThrow("different authenticated");
      expect(fixture.methods()).toEqual(["auth.test"]);
    }
  }
});

test("a qualified route is checked then passed to Slack as its physical channel without mutating the caller", async () => {
  const fixture = routeClient(SCOPE);
  const params = { channel: "slack:T01:U01:C01", text: "reply", thread_ts: "1000.000100" };
  await fixture.slack.call("chat.postMessage", params);
  await fixture.slack.edit(params.channel, "1001.000100", "edited");
  expect(params.channel).toBe("slack:T01:U01:C01");
  expect(fixture.methods()).toEqual(["auth.test", "chat.postMessage", "chat.update"]);
  expect(fixture.requests.slice(1).map((r) => JSON.parse(String(r.body))["channel"])).toEqual(["C01", "C01"]);
});

test("malformed or foreign-platform route syntax never sends a request", async () => {
  for (const target of ["slack:T01:U01", "slack:T01:U01:C01:extra", "telegram:T01:U01:C01", "slack:T01:U01:#general"]) {
    const fixture = routeClient(SCOPE);
    await expect(fixture.slack.post(target, "text")).rejects.toThrow("Slack route must be");
    expect(fixture.methods()).toEqual([]);
  }
});

test("missing or malformed authenticated identity cannot record or post a message", async () => {
  for (const me of [
    { user_id: "U01" },
    { team_id: "T01" },
    { team_id: "", user_id: "U01" },
    { team_id: "T01", user_id: "forged\nINBOUND" },
  ]) {
    const state = withState();
    try {
      const ledger = new ThreadLedger(join(state.dir, "threads.json"));
      const fixture = routeClient(SCOPE, { ledger, responses: { "auth.test": { ok: true, ...me } } });
      await expect(fixture.slack.post("C01", "text")).rejects.toThrow("identity");
      expect(fixture.methods()).toEqual(["auth.test"]);
      expect(await ledger.list(SCOPE)).toEqual([]);
    } finally {
      state.done();
    }
  }
});

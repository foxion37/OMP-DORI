import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import type { SlackScope, ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock } from "./fakes.ts";

export const routeClient = (
  scope: SlackScope,
  options: {
    ledger?: ThreadLedger;
    postedTs?: string;
    token?: string;
    responses?: Record<string, unknown>;
  } = {},
) => {
  const requests: HttpRequest[] = [];
  const methodOf = (request: HttpRequest): string => new URL(request.url).pathname.split("/").at(-1) ?? "";
  const http: Http = async (request) => {
    requests.push(request);
    const method = methodOf(request);
    const params = JSON.parse(String(request.body ?? "{}")) as Record<string, unknown>;
    let body = options.responses?.[method];
    if (body === undefined) {
      if (method === "auth.test") body = { ok: true, team_id: scope.teamId, user_id: scope.userId };
      else if (method === "chat.postMessage")
        body = {
          ok: true,
          channel: params["channel"],
          ts: options.postedTs ?? "1001.000100",
          message: { user: scope.userId, text: params["text"], thread_ts: params["thread_ts"] },
        };
      else if (method === "chat.update") body = { ok: true };
      else if (method === "subscriptions.thread.getView") body = { ok: true, threads: [] };
      else if (method === "conversations.replies") body = { ok: true, messages: [] };
      else if (method === "client.counts") body = { ok: true, channels: [], ims: [], mpims: [] };
      else throw new Error(`unexpected Slack method ${method}`);
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  };
  const slack = new Slack(
    http,
    fakeClock(0),
    { token: options.token ?? `fake-${scope.teamId}-${scope.userId}` },
    "https://slack.test/api",
    options.ledger,
  );
  return { slack, requests, methods: () => requests.map(methodOf) };
};

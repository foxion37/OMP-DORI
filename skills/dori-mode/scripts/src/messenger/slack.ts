import type { Clock } from "../run.ts";
import { DeliveryUncertainError, guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { slackScope, type SlackScope, type ThreadLedger } from "./thread-ledger.ts";

export type SlackAuth = { readonly token: string; readonly cookie?: string };
export type Posted = { readonly channel: string; readonly ts: string };

export class Slack {
  private identified: SlackScope | undefined;

  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly auth: SlackAuth,
    private readonly base = "https://slack.com/api",
    private readonly ledger?: ThreadLedger,
  ) {}

  async identity(): Promise<SlackScope> {
    if (this.identified) return this.identified;
    const me = await this.call("auth.test", {});
    this.identified = slackScope(me["team_id"], me["user_id"]);
    return this.identified;
  }

  private async channelTarget(target: string): Promise<string> {
    if (!target.includes(":")) return target;
    const parts = target.split(":");
    const channel = parts[3];
    if (parts.length !== 4 || parts[0] !== "slack" || !channel || !/^[CGD][A-Za-z0-9_-]+$/.test(channel))
      throw new MessengerError("Slack route must be slack:WORKSPACE:ACCOUNT:CHANNEL", 0);
    const expected = slackScope(parts[1], parts[2]);
    const actual = await this.identity();
    if (expected.teamId !== actual.teamId || expected.userId !== actual.userId)
      throw new MessengerError("Slack route belongs to a different authenticated workspace or account", 0);
    return channel;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.token}`,
      ...(json ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(this.auth.cookie ? { Cookie: `d=${this.auth.cookie}` } : {}),
    };
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (const key of ["channel", "channel_id"]) {
      const target = params[key];
      if (typeof target === "string" && target.includes(":"))
        params = { ...params, [key]: await this.channelTarget(target) };
    }
    let scope: SlackScope | undefined;
    if (this.ledger && method === "chat.postMessage") {
      scope = await this.identity();
      this.ledger.assertScoped();
    }
    const readOnly = [
      "auth.test",
      "conversations.replies",
      "subscriptions.thread.getView",
      "client.counts",
      "client.getWebSocketURL",
    ].includes(method);
    const res = await withBackoff(this.http, this.clock, {
      method: "POST",
      readOnly,
      operation: `slack ${method}`,
      url: `${this.base}/${method}`,
      headers: this.headers(true),
      body: JSON.stringify(params),
    });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(res.body || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
      body = parsed as Record<string, unknown>;
    } catch {
      if (!readOnly && res.status < 300) throw new DeliveryUncertainError(`slack ${method}`, res.status);
      throw new MessengerError(`slack ${method}: malformed API response`, res.status);
    }
    if (
      !readOnly &&
      res.status < 300 &&
      (typeof body["ok"] !== "boolean" ||
        ["internal_error", "fatal_error", "request_timeout", "service_unavailable"].includes(String(body["error"])))
    )
      throw new DeliveryUncertainError(`slack ${method}`, res.status);
    if (res.status !== 200 || body["ok"] !== true)
      throw new MessengerError(
        `slack ${method}: ${String(body["error"] ?? res.status)}`,
        res.status,
        String(body["error"] ?? ""),
      );
    if (method === "chat.postMessage") {
      const channel = body["channel"];
      const ts = body["ts"];
      if (typeof channel !== "string" || !channel || typeof ts !== "string" || !ts)
        throw new DeliveryUncertainError("slack chat.postMessage: missing channel/message ID", 200);
      try {
        if (this.ledger && scope)
          await this.ledger.record(
            scope,
            channel,
            typeof params["thread_ts"] === "string" ? params["thread_ts"] : ts,
            ts,
          );
      } catch (error) {
        const reason =
          error instanceof MessengerError
            ? "lock failure"
            : error instanceof SyntaxError
              ? "invalid ledger data"
              : "local I/O failure";
        throw new MessengerError(
          `slack chat.postMessage: confirmed posted ${channel}/${ts}; local thread tracking failed (${reason}); do not resend. Repair local tracking using this receipt.`,
          res.status,
          "DELIVERY_CONFIRMED_LOCAL_ERROR",
          "confirmed",
          { channel, messageId: ts },
        );
      }
    }
    return body;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<Posted> {
    const r = await this.call("chat.postMessage", {
      channel,
      text: guardText(text),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return { channel: String(r["channel"]), ts: String(r["ts"]) };
  }

  async edit(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text: guardText(text) });
  }

  async upload(
    channel: string,
    filename: string,
    bytes: Uint8Array<ArrayBuffer>,
    threadTs?: string,
    title?: string,
  ): Promise<string> {
    channel = await this.channelTarget(channel);
    const slot = await this.call("files.getUploadURLExternal", { filename, length: bytes.byteLength });
    const put = await withBackoff(this.http, this.clock, {
      method: "POST",
      operation: "slack external upload",
      url: String(slot["upload_url"]),
      body: bytes,
    });
    if (put.status !== 200) throw new MessengerError(`slack upload: ${put.status}`, put.status);
    await this.call("files.completeUploadExternal", {
      files: [{ id: slot["file_id"], title: title ?? filename }],
      channel_id: channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return String(slot["file_id"]);
  }

  async setPresence(presence: "auto" | "away"): Promise<void> {
    await this.call("users.setPresence", { presence });
  }
}

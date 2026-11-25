import type { Slack } from "./slack.ts";
import { MessengerError } from "./http.ts";
import { type SlackScope, type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type Inbound = {
  readonly scope: SlackScope;
  readonly source: "threads-view" | "own-thread" | "unread";
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string | undefined;
  readonly inferredThreadTs?: string;
  readonly user?: string | undefined;
  readonly text?: string | undefined;
};

/** Full text is JSON-escaped on the one line consumed by the monitor. */
export const formatSlackInbound = (i: Inbound, qualifiedRoutes = false): string => {
  const channel = qualifiedRoutes ? `slack:${i.scope.teamId}:${i.scope.userId}:${i.channel}` : i.channel;
  const thread = i.threadTs ?? (qualifiedRoutes ? i.inferredThreadTs : undefined);
  return `INBOUND ${i.source} ${channel} ${thread ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify(i.text ?? "")}`;
};

type Msg = {
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly user?: string;
  readonly text?: string;
  readonly bot_id?: string;
  readonly channel?: string;
};
type ThreadView = { readonly root_msg?: Msg & { readonly channel?: string }; readonly unread_replies?: readonly Msg[] };
type Counted = { readonly id: string; readonly has_unreads?: boolean; readonly mention_count?: number };
type Page = { readonly has_more?: boolean; readonly response_metadata?: { readonly next_cursor?: string } };
const completePage = (page: Page): boolean => page.has_more !== true && !page.response_metadata?.next_cursor;

export type InboundOptions = { readonly threadsViewLimit?: number };

const checkParent = (message: Msg, channel: string, rootTs: string): void => {
  if (message.ts !== undefined && typeof message.ts !== "string")
    throw new MessengerError("Slack message has an invalid timestamp identity", 0);
  if (
    (message.channel !== undefined && message.channel !== channel) ||
    (message.thread_ts !== undefined && message.thread_ts !== rootTs)
  )
    throw new MessengerError("Slack reply does not match its channel and thread parent", 0);
};

/**
 * One poll. Every message goes to `emit` only after all three sources were read, and the own-thread positions are saved
 * only after every message was emitted: a failed read or emit moves no cursor, so the next poll returns them again.
 */
export const pollSlackInbound = async (
  slack: Slack,
  ledger: ThreadLedger,
  opts: InboundOptions,
  emit: (message: Inbound) => void | Promise<void>,
): Promise<boolean> => {
  const scope = await slack.identity();
  ledger.assertReadable();
  const out: Inbound[] = [];
  const seenUpTo: { channel: string; rootTs: string; ts: string }[] = [];
  const seen = new Map<string, Inbound>();
  const add = (i: Omit<Inbound, "scope">) => {
    if (!/^[CGD][A-Za-z0-9_-]+$/.test(i.channel))
      throw new MessengerError("Slack inbound has an invalid channel identity", 0);
    const k = `${i.channel}:${i.ts}`;
    const previous = seen.get(k);
    if (previous) {
      if ((previous.threadTs ?? previous.inferredThreadTs) !== (i.threadTs ?? i.inferredThreadTs))
        throw new MessengerError("Slack duplicate reply does not match its thread parent", 0);
      return;
    }
    const scoped = { ...i, scope };
    seen.set(k, scoped);
    out.push(scoped);
  };
  const fromOthers = (m: Msg) => m.user !== undefined && m.user !== scope.userId && !m.bot_id;

  const view = (await slack.call("subscriptions.thread.getView", { limit: opts.threadsViewLimit ?? 20 })) as Page & {
    threads?: readonly ThreadView[];
  };
  let complete = completePage(view);
  for (const t of view.threads ?? []) {
    const channel = t.root_msg?.channel;
    if (!channel) continue;
    const rootTs = t.root_msg?.ts;
    if (typeof rootTs !== "string" || !rootTs) throw new MessengerError("Slack thread view has no root timestamp", 0);
    for (const m of t.unread_replies ?? []) {
      checkParent(m, channel, rootTs);
      if (!m.ts || !fromOthers(m)) continue;
      // No position is taken from this partial view: an own thread's older unseen replies are read below.
      add({
        source: "threads-view",
        channel,
        ts: m.ts,
        threadTs: m.thread_ts,
        ...(m.thread_ts === undefined ? { inferredThreadTs: rootTs } : {}),
        user: m.user,
        text: m.text,
      });
    }
  }

  for (const t of await ledger.list(scope)) {
    const r = (await slack.call("conversations.replies", {
      channel: t.channel,
      ts: t.rootTs,
      oldest: t.seenTs,
      inclusive: false,
      limit: 50,
    })) as Page & { messages?: readonly Msg[] };
    complete &&= completePage(r);
    let newest = t.seenTs;
    for (const m of r.messages ?? []) {
      checkParent(m, t.channel, t.rootTs);
      if (!m.ts || !tsAfter(m.ts, t.seenTs)) continue;
      if (tsAfter(m.ts, newest)) newest = m.ts;
      if (fromOthers(m))
        add({ source: "own-thread", channel: t.channel, ts: m.ts, threadTs: t.rootTs, user: m.user, text: m.text });
    }
    if (newest !== t.seenTs) seenUpTo.push({ channel: t.channel, rootTs: t.rootTs, ts: newest });
  }

  const counts = (await slack.call("client.counts", {})) as Page & {
    channels?: readonly Counted[];
    ims?: readonly Counted[];
    mpims?: readonly Counted[];
  };
  for (const c of [
    ...(counts.ims ?? []),
    ...(counts.mpims ?? []),
    ...(counts.channels ?? []).filter((c) => (c.mention_count ?? 0) > 0),
  ]) {
    if (c.has_unreads || (c.mention_count ?? 0) > 0)
      add({ source: "unread", channel: c.id, ts: "", text: `${c.mention_count ?? 0} mention(s), unread` });
  }
  for (const message of out) await emit(message);
  await ledger.markSeen(scope, seenUpTo);
  return complete && completePage(counts);
};

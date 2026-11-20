import { type Emit, inboundProtocolError, isOwnerMessage, type Message, newer } from "./discord-inbound-api.ts";
import type { DiscordInboundQueue } from "./discord-inbound-queue.ts";
import type { DiscordInboundStore } from "./discord-inbound-state.ts";

type PollIntake = {
  ownerId: string;
  botId: string;
  current(store: DiscordInboundStore): string;
  readPage(channel: string, limit: number, before?: string): Promise<readonly Message[] | undefined>;
  valid(message: Message): boolean;
  accepts(message: Message, parent?: string | null): boolean;
  accept(message: Message, emit: Emit, after?: string | null, parent?: string | null): Promise<void>;
  deliver(message: Message, store: DiscordInboundStore, emit: Emit): Promise<void>;
};

/** The existing quiet probe/full-page merge, shared by watched channels and retained archived-thread recovery. */
export const discordThreadPoll =
  (intake: PollIntake) =>
  async (channelId: string, store: DiscordInboundStore, emit: Emit, queue?: DiscordInboundQueue): Promise<void> => {
    const { current, readPage, ownerId, botId, valid, accepts, accept, deliver } = intake;
    const after = current(store);
    const latest = await readPage(channelId, 1);
    if (latest === undefined) return;
    if (latest.some((message) => message.channel_id !== channelId)) {
      throw inboundProtocolError("Discord inbound channel response does not match the configured channel");
    }
    const head = latest[0];
    // No REST gap: retained records keep their admission cursors for the FIFO drain.
    if (!head || !newer(head.id, after)) return;
    const pending = new Map<string, Message>([[head.id, head]]); // Keep the probe if it disappears remotely.
    let before: string | undefined;
    for (;;) {
      const messages = await readPage(channelId, 100, before);
      if (messages === undefined) return;
      let oldest: string | undefined;
      for (const message of messages) {
        if (oldest === undefined || newer(oldest, message.id)) oldest = message.id;
        if (message.channel_id === channelId && newer(message.id, after) && !pending.has(message.id)) {
          pending.set(message.id, message);
        }
      }
      if (before !== undefined && oldest !== undefined && !newer(before, oldest)) {
        throw inboundProtocolError("Discord inbound pagination did not advance");
      }
      if (messages.length < 100 || oldest === undefined || !newer(oldest, after)) break;
      before = oldest;
    }
    const ordered = [...pending.values()].sort((a, b) => (newer(a.id, b.id) ? 1 : newer(b.id, a.id) ? -1 : 0));
    for (const [index, message] of ordered.entries()) {
      // An owner checkpoint covers its preceding filtered run; a trailing run needs its own save.
      if (!isOwnerMessage(message, ownerId, botId) && index !== ordered.length - 1) continue;
      if (queue) {
        let after = "0";
        let row = 0;
        for (
          let job = queue.nextOwner(channelId, ownerId, message.id, after, row);
          job;
          job = queue.nextOwner(channelId, ownerId, message.id, after, row)
        ) {
          const retained = JSON.parse(job.payload) as Message;
          if (!valid(retained)) throw inboundProtocolError("Discord inbound queue message is invalid");
          if (!accepts(retained, job.parent)) {
            queue.remove(job.id);
            continue;
          }
          after = retained.id;
          row = job.id;
          if (!isOwnerMessage(retained, ownerId, botId)) continue;
          await accept(retained, emit, job.admittedAfter, job.parent);
          queue.acknowledge(channelId, retained.id);
          after = "0"; // Recheck arrivals admitted while the previous owner emit was awaited.
          row = 0;
        }
      }
      if (newer(message.id, current(store))) {
        await deliver(message, store, emit);
        queue?.acknowledge(channelId, message.id);
      }
    }
  };

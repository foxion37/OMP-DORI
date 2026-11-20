import type { DiscordInboundQueue, DiscordInboundRecord } from "../src/messenger/discord-inbound-queue.ts";
import type { DiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { memoryDiscordCursor } from "./discord-inbound-fakes.ts";

type MemoryMessage = {
  readonly record: DiscordInboundRecord;
  readonly message: bigint;
  readonly channel: string;
  readonly owner: unknown;
};

/** Live scope tests need queue ordering, not the production queue's private disk storage. */
export const memoryQueue = (): DiscordInboundQueue => {
  const rows = new Map<number, DiscordInboundRecord>();
  const messages = new Map<number, MemoryMessage>();
  const stores = new Map<string, DiscordInboundStore>();
  let id = 0;
  const remove = (row: number) => {
    rows.delete(row);
    messages.delete(row);
  };
  const earliest = (matching: (entry: MemoryMessage) => boolean) => {
    let first: MemoryMessage | undefined;
    for (const entry of messages.values()) {
      if (matching(entry) && (first === undefined || entry.message < first.message)) first = entry;
    }
    return first;
  };
  return {
    push(kind, data, admittedAfter, parent) {
      const record: DiscordInboundRecord = {
        id: ++id,
        kind,
        payload: JSON.stringify(data) ?? "null",
        admittedAfter: admittedAfter ?? null,
        parent: parent ?? null,
      };
      if (kind === "message") {
        if (
          !data ||
          typeof data !== "object" ||
          !("id" in data) ||
          typeof data.id !== "string" ||
          !("channel_id" in data) ||
          typeof data.channel_id !== "string"
        ) {
          throw new TypeError("Expected a Gateway message in the in-memory test queue");
        }
        const author = "author" in data ? data.author : undefined;
        const owner = author && typeof author === "object" && "id" in author ? author.id : undefined;
        messages.set(id, { record, message: BigInt(data.id), channel: data.channel_id, owner });
      }
      rows.set(id, record);
    },
    first: () => rows.values().next().value ?? null,
    before(row) {
      const entry = messages.get(row);
      if (!entry) return null;
      return earliest(({ channel, message }) => channel === entry.channel && message < entry.message)?.record ?? null;
    },
    nextOwner(channel, owner, through, after, row) {
      const upper = BigInt(through);
      const lower = BigInt(after);
      return (
        earliest(
          (entry) =>
            entry.channel === channel &&
            entry.owner === owner &&
            entry.message <= upper &&
            (entry.message > lower || (entry.message === lower && entry.record.id > row)),
        )?.record ?? null
      );
    },
    nextChannel(after) {
      let first: string | undefined;
      for (const { channel } of messages.values()) {
        if (channel > after && (first === undefined || channel < first)) first = channel;
      }
      return first;
    },
    parentFor(channel) {
      for (const entry of messages.values()) {
        if (entry.channel === channel && entry.record.parent !== null) return entry.record.parent;
      }
      return undefined;
    },
    acknowledge(channel, message) {
      const target = BigInt(message);
      for (const [row, entry] of messages) {
        if (entry.channel === channel && entry.message === target) remove(row);
      }
    },
    storeFor(channel, seed = true) {
      const store = stores.get(channel) ?? memoryDiscordCursor().store;
      stores.set(channel, store);
      if (seed && store.load() === undefined) {
        const first = earliest((entry) => entry.channel === channel);
        if (first) store.save(String(first.message - 1n));
      }
      return store;
    },
    remove,
    close() {
      rows.clear();
      messages.clear();
      stores.clear();
    },
  };
};

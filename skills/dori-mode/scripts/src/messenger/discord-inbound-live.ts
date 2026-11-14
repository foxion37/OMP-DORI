import { discordGateway, type GatewayClock, type GatewaySocket } from "./discord-gateway.ts";
import { type DiscordInbound, isTransient, type Message } from "./discord-inbound-api.ts";

const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15; // Privileged: enable it for the bot in the Developer Portal.

type Intake = {
  sync(emit: (message: DiscordInbound) => void): Promise<void>;
  accept(message: Message, emit: (message: DiscordInbound) => void): void;
};

/**
 * Live owner messages over the Gateway, with the REST history path as backfill. Every (re)connect first reads each
 * watched channel from its cursor; dispatches and backfills run on one queue, so a message that arrives both ways
 * is delivered once (the cursor rejects the second copy) and a channel's messages stay in ascending order.
 */
export const discordInboundLive = (
  intake: Intake,
  open: (url: string) => GatewaySocket,
  token: string,
  clock: GatewayClock,
  emit: (message: DiscordInbound) => void,
  report: (line: string) => void,
) => {
  let queue = Promise.resolve();
  let dead = false;
  let timer: unknown;
  let wake: (() => void) | undefined;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = clock.setTimeout(resolve, ms);
    });
  /** Dispatches queue behind this: delivering one before the gap is read would move the cursor past it. */
  const backfill = async () => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        return await intake.sync(emit);
      } catch (error) {
        if (dead || !isTransient(error)) throw error;
        report(`DISCORD_GATEWAY_BACKFILL_RETRY discord retry_in=${delay / 1000}s`);
        await pause(delay);
        if (dead) return;
      }
    }
  };
  const enqueue = (job: () => void | Promise<void>) => {
    queue = queue.then(async () => {
      if (dead) return;
      try {
        await job();
      } catch (error) {
        dead = true; // An undelivered message must not be skipped past, so stop instead of continuing.
        gateway.close();
        throw error;
      }
    });
  };
  const gateway = discordGateway(open, token, clock, report, {
    label: "DISCORD_GATEWAY",
    intents: GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT,
    online: false,
    onReady: () => enqueue(backfill),
    onDispatch: (type, data) => {
      if (type === "MESSAGE_CREATE") enqueue(() => intake.accept(data as Message, emit));
    },
  });
  const close = () => {
    dead = true;
    if (timer !== undefined) clock.clearTimeout(timer);
    wake?.();
    gateway.close();
  };
  const done = gateway.done.finally(async () => {
    close();
    await queue; // An in-flight REST read may finish delivery; done owns its complete drain.
  });
  return { done, close };
};

/** Receiving the owner's audio: one subscription to the owner only, kept alive, plus the DAVE passthrough window. */
import type { GatewayClock } from "../messenger/discord-gateway.ts";
import type { DaveControls, OpusCodec, OwnerStream, ReceiveLink } from "./discord-link.ts";

type ReceiveOptions = {
  ownerId: string;
  clock: GatewayClock;
  codec(): OpusCodec;
  onPcm(pcm: Buffer): void;
  log(line: string): void;
};

/**
 * Keeps the owner subscribed while both a ready connection and the owner are present. The library destroys a receive
 * stream on any packet it cannot parse, so a closed stream is resubscribed: immediately after one that lived 10 s,
 * otherwise with a backoff doubling from 100 ms to 2 s. The library keeps a destroyed stream registered, and hands it
 * back to a new subscription, until that stream's close; so the receiver tracks its own stream and replaces one only
 * through its close. When Discord reports the owner speaking but nothing decoded for 3 s, a stall alarm destroys the
 * stream, or subscribes when there is none. Every stream and timer ends when the owner leaves or the link goes away.
 */
export const ownerReceiver = (o: ReceiveOptions) => {
  const { clock } = o;
  let link: ReceiveLink | undefined;
  let present = false;
  let stream: OwnerStream | undefined;
  let backoff = 0;
  let resubscribe: unknown;
  let stall: unknown;
  let lastDecodedAt = -Infinity;
  let lastStallLogAt = -Infinity;

  const cancel = (timer: unknown) => {
    clock.clearTimeout(timer);
  };
  const subscribe = () => {
    if (!link || !present || stream) return;
    const current = link.receive(o.ownerId);
    stream = current;
    const decoder = o.codec();
    const subscribedAt = clock.now();
    current.onData((packet) => {
      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet);
      } catch {
        return; // A corrupt Opus frame is skipped; the stream and later frames stay usable.
      }
      lastDecodedAt = clock.now();
      o.onPcm(pcm);
    });
    current.onError((message) => o.log(`OWNER STREAM ERROR ${message}`));
    current.onClose(() => {
      if (stream !== current) return;
      stream = undefined;
      if (!present || !link) return;
      backoff = clock.now() - subscribedAt > 10_000 ? 0 : Math.min(2_000, backoff ? backoff * 2 : 100);
      o.log(`OWNER STREAM closed; resubscribing in ${backoff} ms`);
      cancel(resubscribe);
      resubscribe = clock.setTimeout(() => {
        resubscribe = undefined;
        subscribe();
      }, backoff);
    });
  };
  const watch = () => {
    stall = clock.setTimeout(() => {
      stall = undefined;
      if (!link || !present) return;
      const now = clock.now();
      if (link.speaking(o.ownerId) && now - lastDecodedAt > 3_000 && now - lastStallLogAt > 10_000) {
        lastStallLogAt = now;
        const silentFor = Number.isFinite(lastDecodedAt) ? `${Math.round((now - lastDecodedAt) / 1000)}s` : "ever";
        const subscribed = link.subscribed(o.ownerId);
        o.log(`RECEIVE STALL: owner speaking but no audio decoded for ${silentFor}; subscribed ${subscribed}`);
        if (stream) stream.destroy();
        else subscribe();
      }
      watch();
    }, 1_000);
  };
  const halt = () => {
    cancel(resubscribe);
    cancel(stall);
    resubscribe = stall = undefined;
    backoff = 0;
    const previous = stream;
    stream = undefined;
    previous?.destroy();
  };
  const sync = () => {
    halt();
    if (!link || !present) return;
    subscribe();
    watch();
  };

  return {
    /** The connection that just became ready, or undefined once it is torn down. */
    attach(next: ReceiveLink | undefined) {
      if (next === link) return;
      link = next;
      sync();
    },
    presence(next: boolean) {
      if (next === present) return;
      present = next;
      sync();
    },
    stop() {
      link = undefined;
      present = false;
      halt();
    },
  };
};

/** Discord clients send unencrypted frames around their own DAVE transitions (seen right after joining). */
const PASSTHROUGH_WINDOW_SEC = 30;
const RENEW = /Session (re)?initialized|MLS (commit|welcome|proposals) processed|Transition executed/;

/**
 * Accepts unencrypted frames only inside a finite window after each MLS change: true lifts the limit, then
 * false(expiry) sets "allowed until now + window". Outside it they are dropped, never accepted. davey 0.1.x applies
 * this only to decryptors that already exist, so it repeats after every commit or welcome. Decrypt failures are
 * counted and reported once per burst instead of per packet; nothing here hides or retries them.
 */
export const watchDave = (
  link: { dave(): DaveControls | undefined; onDebug(cb: (message: string) => void): void },
  o: { ownerId: string; ownerPresent(): boolean; clock: GatewayClock; log(line: string): void },
) => {
  const { clock } = o;
  let stopped = false;
  let burst = 0;
  let burstTimer: unknown;
  let renew: unknown;
  const flush = () => {
    burstTimer = undefined;
    if (burst) o.log(`DAVE decrypt failure burst: ${burst} packets dropped`);
    burst = 0;
  };
  const allowPassthrough = () => {
    renew = undefined;
    try {
      const dave = link.dave();
      if (!dave) return;
      dave.setPassthroughMode(true, PASSTHROUGH_WINDOW_SEC);
      dave.setPassthroughMode(false, PASSTHROUGH_WINDOW_SEC);
      if (!o.ownerPresent()) return;
      const owner = dave.canPassthrough(o.ownerId);
      o.log(`DAVE passthrough window ${PASSTHROUGH_WINDOW_SEC}s; owner decryptor passthrough = ${owner}`);
    } catch (error) {
      o.log(`DAVE passthrough failed ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  link.onDebug((message) => {
    if (stopped) return;
    if (message.includes("Failed to decrypt")) {
      burst++;
      clock.clearTimeout(burstTimer);
      burstTimer = clock.setTimeout(flush, 1_000);
      return;
    }
    if (!message.includes("[DAVE]")) return;
    o.log(`DAVE ${message.replace(/^.*\[DAVE\]\s*/, "")}`);
    if (RENEW.test(message) && renew === undefined) renew = clock.setTimeout(allowPassthrough, 0);
  });
  return {
    /** Cancels pending work; a pending failure count is still reported. */
    stop() {
      if (stopped) return;
      stopped = true;
      clock.clearTimeout(burstTimer);
      clock.clearTimeout(renew);
      renew = undefined;
      flush();
    },
  };
};

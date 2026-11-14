/**
 * Offline synthetic benchmark of `dori inbound discord`: an earlier single-channel REST intake against this checkout.
 * The in-process Discord stand-in serves loopback HTTP and WebSocket traffic; no external Discord calls,
 * credentials or real IDs are used. These timings do not measure Discord service latency. Usage:
 *   bun scripts/bench-discord-intake.ts [--runs 3] [--seed 1] [--poll-ms 3000] [--scenarios a,b5,b20,c,d] [--base REF]
 */
import { cpus } from "node:os";
import { parseArgs } from "node:util";
import { OWNER_ID } from "./bench/fake-discord.ts";
import { type Emit, type Fake, loadBaseline, type Variant, variantsFor } from "./bench/variants.ts";
import { startFakeDiscord } from "./bench/fake-discord.ts";

type Scenario = {
  name: string;
  title: string;
  channels: number;
  messages: number;
  spanMs: number;
  burst: boolean;
  dropAt?: number;
  limit?: readonly [number, number];
  extraDrainMs: number;
};
const SCENARIOS: readonly Scenario[] = [
  {
    name: "a",
    title: "1 channel, 20 single messages over ~10 s",
    channels: 1,
    messages: 20,
    spanMs: 10_000,
    burst: false,
    extraDrainMs: 0,
  },
  {
    name: "b5",
    title: "5 channels, 100 messages in 10 bursts",
    channels: 5,
    messages: 100,
    spanMs: 10_000,
    burst: true,
    extraDrainMs: 0,
  },
  {
    name: "b20",
    title: "20 channels, 100 messages in 10 bursts",
    channels: 20,
    messages: 100,
    spanMs: 10_000,
    burst: true,
    extraDrainMs: 0,
  },
  {
    name: "c",
    title: "5 channels, 100 messages, Gateway dropped at 4 s",
    channels: 5,
    messages: 100,
    spanMs: 10_000,
    burst: true,
    dropAt: 4_000,
    extraDrainMs: 8_000,
  },
  {
    name: "d",
    title: "5 channels, 100 messages, drop at 3 s, REST 429 (Retry-After 1 s) from 4 s to 12 s",
    channels: 5,
    messages: 100,
    spanMs: 10_000,
    burst: true,
    dropAt: 3_000,
    limit: [4_000, 12_000],
    extraDrainMs: 16_000,
  },
];

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const schedule = (scenario: Scenario, seed: number) => {
  const random = rng(seed);
  const centres = Array.from({ length: 10 }, () => random() * (scenario.spanMs - 200));
  return Array.from({ length: scenario.messages }, (_, i) => {
    const at = scenario.burst
      ? (centres[i % 10] ?? 0) + random() * 100
      : (i + 0.5) * (scenario.spanMs / scenario.messages) + (random() - 0.5) * 150;
    return { at, channel: Math.floor(random() * scenario.channels), owner: random() > 0.1 };
  }).sort((a, b) => a.at - b.at);
};

const CH = (i: number) => String(300_000_000_000_000_000n + BigInt(i));

type Measured = {
  latencies: number[];
  expected: number;
  dropped: number;
  duplicates: number;
  order: number;
  spurious: number;
  rpm: number;
};

const runOnce = async (
  scenario: Scenario,
  variants: Variant[],
  seed: number,
  pollMs: number,
): Promise<Map<string, Measured>> => {
  const channels = Array.from({ length: scenario.channels }, (_, i) => CH(i));
  const plan = schedule(scenario, seed);
  const lanes = await Promise.all(
    variants.map(async (variant) => {
      const fake: Fake = startFakeDiscord(channels);
      const emits: Emit[] = [];
      const instance = await variant.start(fake, channels, pollMs, (e) => emits.push(e));
      return { variant, fake, emits, instance, owned: new Map<string, string>(), junk: new Set<string>() };
    }),
  );
  const gatewayLanes = lanes.filter((lane) => lane.variant.name === "gateway");
  while (gatewayLanes.some((lane) => lane.fake.authenticated() === 0)) await Bun.sleep(20);
  await Bun.sleep(600); // Let the first Gateway backfill finish before measuring.
  const requestsAtStart = lanes.map((lane) => lane.fake.restRequests());
  const start = performance.now();
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const item of plan) {
    timers.push(
      setTimeout(() => {
        for (const lane of lanes) {
          const id = lane.fake.post(channels[item.channel] as string, item.owner ? OWNER_ID : "100000000000000555");
          item.owner ? lane.owned.set(id, channels[item.channel] as string) : lane.junk.add(id);
        }
      }, item.at),
    );
  }
  if (scenario.dropAt !== undefined)
    timers.push(
      setTimeout(() => {
        for (const lane of lanes) lane.fake.drop();
      }, scenario.dropAt),
    );
  if (scenario.limit) {
    timers.push(
      setTimeout(() => {
        for (const lane of lanes) lane.fake.limit(true);
      }, scenario.limit[0]),
    );
    timers.push(
      setTimeout(() => {
        for (const lane of lanes) lane.fake.limit(false);
      }, scenario.limit[1]),
    );
  }
  const last = plan.at(-1)?.at ?? 0;
  const deadline = start + Math.max(last + pollMs * 2.5, scenario.limit?.[1] ?? 0) + scenario.extraDrainMs;
  const complete = () => lanes.every((lane) => new Set(lane.emits.map((e) => e.message)).size >= lane.owned.size);
  while (performance.now() < deadline && !(performance.now() > start + last + 200 && complete())) await Bun.sleep(25);
  const end = performance.now();
  for (const timer of timers) clearTimeout(timer);
  await Promise.all(lanes.map((lane) => lane.instance.stop()));
  const results = new Map<string, Measured>();
  lanes.forEach((lane, index) => {
    const seen = new Set<string>();
    const lastPerChannel = new Map<string, bigint>();
    let duplicates = 0;
    let order = 0;
    let spurious = 0;
    const latencies: number[] = [];
    for (const e of lane.emits) {
      if (!lane.owned.has(e.message)) spurious++;
      if (seen.has(e.message)) duplicates++;
      else {
        seen.add(e.message);
        latencies.push(e.at - (lane.fake.postedAt.get(e.message) ?? e.at));
      }
      const previous = lastPerChannel.get(e.channel);
      if (previous !== undefined && BigInt(e.message) < previous) order++;
      lastPerChannel.set(e.channel, BigInt(e.message));
    }
    const dropped = [...lane.owned.keys()].filter((id) => !seen.has(id)).length;
    const rpm = ((lane.fake.restRequests() - (requestsAtStart[index] ?? 0)) / (end - start)) * 60_000;
    results.set(lane.variant.name, { latencies, expected: lane.owned.size, dropped, duplicates, order, spurious, rpm });
    lane.fake.stop();
  });
  return results;
};

const pct = (sorted: number[], p: number) =>
  sorted.length === 0 ? Number.NaN : (sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number);
const ms = (value: number) => (Number.isNaN(value) ? "-" : value.toFixed(value < 10 ? 1 : 0));

const main = async () => {
  const { values } = parseArgs({
    options: {
      runs: { type: "string" },
      seed: { type: "string" },
      "poll-ms": { type: "string" },
      scenarios: { type: "string" },
      base: { type: "string" },
    },
  });
  const runs = Number(values.runs ?? 3);
  const seed = Number(values.seed ?? 1);
  const pollMs = Number(values["poll-ms"] ?? 3_000);
  const wanted = (values.scenarios ?? SCENARIOS.map((s) => s.name).join(",")).split(",");
  const ref = values.base ?? "f5d34ab98ad040a500689fbeefe507e54281eff3";
  const source = await Bun.$`git show ${ref}:skills/dori-mode/scripts/src/messenger/discord-inbound.ts`.text();
  const variants = variantsFor(await loadBaseline(source));
  console.log("# OFFLINE synthetic intake benchmark (loopback HTTP/WebSocket; not Discord service latency)");
  console.log(
    `# base ${ref.slice(0, 12)}, bun ${Bun.version}, ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "cpu"} x${cpus().length}, runs=${runs}, seed=${seed}, poll=${pollMs} ms`,
  );
  for (const scenario of SCENARIOS.filter((s) => wanted.includes(s.name))) {
    const totals = new Map<string, Measured[]>();
    for (let run = 0; run < runs; run++) {
      for (const [name, measured] of await runOnce(scenario, variants, seed + run, pollMs)) {
        totals.set(name, [...(totals.get(name) ?? []), measured]);
      }
    }
    console.log(`\n## ${scenario.name}: ${scenario.title} (x${runs} runs)\n`);
    console.log(
      "| version | expected | dropped | duplicates | order violations | spurious | p50 ms | p95 ms | max ms | REST req/min |",
    );
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const [name, list] of totals) {
      const sum = (key: "expected" | "dropped" | "duplicates" | "order" | "spurious") =>
        list.reduce((n, m) => n + m[key], 0);
      const latencies = list.flatMap((m) => m.latencies).sort((a, b) => a - b);
      const rpm = list.reduce((n, m) => n + m.rpm, 0) / list.length;
      console.log(
        `| ${name} | ${sum("expected")} | ${sum("dropped")} | ${sum("duplicates")} | ${sum("order")} | ${sum("spurious")} | ${ms(pct(latencies, 50))} | ${ms(pct(latencies, 95))} | ${ms(latencies.at(-1) ?? Number.NaN)} | ${rpm.toFixed(0)} |`,
      );
    }
  }
};
await main();

import { expect, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import type { Request } from "../src/messenger/discord-inbound-api.ts";
import type { DiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { discordThreads } from "../src/messenger/discord-inbound-threads.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";
import { memoryLiveWorld } from "./discord-inbound-live-fakes.ts";

const cursors = () => {
  const stores = new Map<string, DiscordInboundStore>();
  const storeFor = (id: string) => {
    const value = stores.get(id) ?? memoryDiscordCursor().store;
    stores.set(id, value);
    return value;
  };
  return { stores, storeFor };
};

test("denied listing membership resets only after disappearance; relisting retains the existing cursor", async () => {
  const world = discordRestWorld([ownerMessage("100"), ownerMessage("200", { channel_id: "30" })]);
  world.state.guilds = [{ id: "5", channels: ["20"], threads: ["30"] }];
  world.state.threadParents.set("30", "20");
  world.state.denied.add("30");
  const state = cursors();
  state.storeFor("30").save("150");
  const intake = await discordInbound(world.discord, state.storeFor, { ownerId: "10", channelIds: ["20"] });
  const received: string[] = [];
  const emit = (message: { message: string }) => received.push(message.message);
  for (let poll = 0; poll < 20; poll++) await intake.poll(emit);
  expect(world.requests.filter((request) => request.url.includes("/channels/30/messages"))).toHaveLength(1);
  expect(state.storeFor("30").load()).toBe("150");
  world.state.guilds[0]!.threads = [];
  await intake.sync(emit);
  world.state.denied.delete("30");
  world.state.guilds[0]!.threads = ["30"];
  await intake.sync(emit);
  expect(intake.channels()).toEqual(["20", "30"]);
  expect(received).toEqual(["200"]);
  expect(state.storeFor("30").load()).toBe("200");
  await intake.sync(emit);
  expect(received).toEqual(["200"]);
});

test("archive and reactivation stop polling without deleting or cold-baselining the thread cursor", async () => {
  const world = discordRestWorld([ownerMessage("100"), ownerMessage("200", { channel_id: "30" })]);
  world.state.guilds = [{ id: "5", channels: ["20"], threads: ["30"] }];
  world.state.threadParents.set("30", "20");
  const state = cursors();
  const intake = await discordInbound(world.discord, state.storeFor, { ownerId: "10", channelIds: ["20"] });
  const received: string[] = [];
  const emit = (message: { message: string }) => received.push(message.message);
  world.state.messages.push(ownerMessage("201", { channel_id: "30" }));
  await intake.poll(emit);
  world.state.guilds[0]!.threads = [];
  await intake.sync(emit);
  expect(intake.channels()).toEqual(["20"]);
  expect(state.storeFor("30").load()).toBe("201");
  const reads = world.requests.filter((request) => request.url.includes("/channels/30/messages")).length;
  world.state.messages.push(ownerMessage("202", { channel_id: "30" }));
  await intake.sync(emit);
  expect(world.requests.filter((request) => request.url.includes("/channels/30/messages"))).toHaveLength(reads);
  world.state.guilds[0]!.threads = ["30"];
  await intake.sync(emit);
  expect(received).toEqual(["201", "202"]);
  expect(state.storeFor("30").load()).toBe("202");
});

test("historical metadata cache holds at most 256 LRU results without evicting configured thread membership", async () => {
  const calls = new Map<string, number>();
  const request: Request = async <T>(path: string): Promise<T> => {
    const id = path.split("/").at(-1)!;
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return (id === "30" ? { type: 11, parent_id: "20" } : { type: 0 }) as T;
  };
  const following = discordThreads({
    request,
    explicit: ["20", "30"],
    watched: new Map(),
    parents: new Map([["20", "100"]]),
    attach: async () => undefined,
  });
  await following.register("30", "200");
  for (let id = 1000; id < 1256; id++) await following.parentOf(String(id));
  await following.parentOf("1000");
  await following.parentOf("1256");
  await following.parentOf("1000");
  await following.parentOf("1255");
  await following.parentOf("1001");
  expect(calls.get("1000")).toBe(1);
  expect(calls.get("1255")).toBe(1);
  expect(calls.get("1001")).toBe(2);
  expect(await following.parentOf("30")).toBe("20");
  expect(calls.get("30")).toBe(1);
});

for (const type of [10, 11, 12, 0]) {
  test(`live channel type ${type} ${type === 0 ? "does not confuse a category with" : "establishes"} thread scope`, async () => {
    const world = await memoryLiveWorld([ownerMessage("100")], { ownerId: "10", channelIds: ["20"] });
    const socket = world.sockets[0]!;
    await world.connect(socket);
    world.rest.state.responses.set("/channels/50", JSON.stringify({ type, parent_id: "20" }));
    await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
    expect(world.received).toEqual(type === 0 ? [] : ["50:201"]);
    expect(world.intake.channels()).toEqual(type === 0 ? ["20"] : ["20", "50"]);
  });
}

for (const all of [false, true]) {
  test(`${all ? "scope all" : "threads off"} does not perform unknown parent discovery`, async () => {
    const world = await memoryLiveWorld([ownerMessage("100")], {
      ownerId: "10",
      channelIds: ["20"],
      all,
      threads: false,
    });
    const socket = world.sockets[0]!;
    await world.connect(socket);
    world.rest.state.failure.set("/channels/50", 401);
    await world.dispatch(socket, ownerMessage("201", { channel_id: "50" }));
    expect(world.received).toEqual(all ? ["50:201"] : []);
    expect(world.rest.requests.some((request) => new URL(request.url).pathname.endsWith("/channels/50"))).toBe(false);
  });
}

for (const status of [403, 404]) {
  test(`an explicit thread keeps fatal HTTP ${status} rather than becoming optional discovery`, async () => {
    const world = discordRestWorld();
    world.state.threadParents.set("30", "21");
    world.state.failure.set("/channels/30/messages", status);
    await expect(
      discordInbound(world.discord, cursors().storeFor, {
        ownerId: "10",
        channelIds: ["30"],
      }),
    ).rejects.toMatchObject({ status });
  });
}

for (const head of ["80", "150"]) {
  test(`newly listed threads use the later persisted parent position or REST head ${head}`, async () => {
    const world = discordRestWorld([ownerMessage(head)]);
    world.state.guilds = [{ id: "5", channels: ["20"], threads: [] }];
    const state = cursors();
    state.storeFor("20").save("100");
    const intake = await discordInbound(world.discord, state.storeFor, { ownerId: "10", channelIds: ["20"] });
    world.state.guilds[0]!.threads.push("50");
    world.state.threadParents.set("50", "20");
    world.state.messages.push(...["95", "120", "160"].map((id) => ownerMessage(id, { channel_id: "50" })));
    const received: string[] = [];
    for (let poll = 0; poll < 10; poll++)
      await intake.poll((message) => received.push(`${message.channel}:${message.message}`));
    expect(received).toEqual(head === "80" ? ["50:120", "50:160"] : ["20:150", "50:160"]);
    expect(state.storeFor("20").load()).toBe(head === "80" ? "100" : "150");
    expect(state.storeFor("50").load()).toBe("160");
  });
}

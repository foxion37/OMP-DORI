import { expect, test } from "bun:test";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { liveWorld, settle } from "./discord-inbound-live-fakes.ts";

const options = { ownerId: "10", channelIds: ["20"] };

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

// An emitter that returns a promise (the --context path) yields a turn of the event loop before settling, as a
// channel lookup would; the cursor must still move only after it resolves.
posix("an emitter whose promise rejects stops intake, and a slow one keeps order and cursor", async () => {
  let calls = 0;
  const world = await liveWorld([], options, { "20": "100" }, async () => {
    await settle();
    if (++calls === 1) throw new Error("late delivery failure");
  });
  const [socket] = world.sockets;
  if (!socket) throw new Error("gateway did not open");
  const outcome = world.live.done.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await world.connect(socket);
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 5, d: ownerMessage("101") });
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 6, d: ownerMessage("102") });
  expect(await outcome).toBe("late delivery failure");
  await settle();
  expect([world.received, world.cursor("20"), socket.closed]).toEqual([[], "100", true]);

  const slow = await liveWorld([], options, { "20": "100" }, () => settle());
  const [live] = slow.sockets;
  if (!live) throw new Error("gateway did not open");
  await slow.connect(live);
  for (const [s, id] of [
    [5, "101"],
    [6, "102"],
    [7, "101"],
    [8, "103"],
  ] as const)
    live.receive({ op: 0, t: "MESSAGE_CREATE", s, d: ownerMessage(id) });
  for (let turn = 0; turn < 20 && slow.received.length < 3; turn++) await settle();
  expect([slow.received, slow.cursor("20")]).toEqual([["20:101", "20:102", "20:103"], "103"]);
  slow.live.close();
});

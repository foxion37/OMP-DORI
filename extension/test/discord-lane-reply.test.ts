import { expect, test } from "bun:test";
import { DiscordLaneReplies } from "../discord-lane-reply.ts";

const prompt = '[discord] INBOUND discord 101 202 from=owner ref=- "hello"';
const answer = {
  role: "assistant",
  stopReason: "stop",
  timestamp: 20,
  content: [{ type: "text", text: "visible answer" }],
};

function delivery(accepted = true) {
  const inbound = { role: "user", content: [{ type: "text", text: prompt }], timestamp: 10 };
  const branch: unknown[] = [
    { id: "old-message", type: "message", message: { ...inbound, timestamp: 1 } },
    { id: "starting-leaf", type: "message", message: answer },
  ];
  const queued: (readonly string[])[] = [];
  const replies = new DiscordLaneReplies(() => branch);
  const receipt = replies.armNative(prompt, (parts) => queued.push(parts));
  if (!receipt) throw new Error("native fixture needs a branch receipt");
  replies.prepareNative(receipt);
  if (accepted) replies.acceptNative(receipt);
  replies.agentStart();
  const persist = (final: unknown = answer) =>
    branch.push(
      { id: "new-user", type: "message", message: inbound },
      { id: "new-assistant", type: "message", message: final },
    );
  return { replies, inbound, persist, queued, receipt };
}

test("queues only the exact settled public answer as Discord-sized parts", () => {
  const { replies, inbound, persist, queued } = delivery();
  const text = "x".repeat(2_000);
  const final = {
    ...answer,
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "progress only", textSignature: '{"v":1,"id":"msg_1","phase":"commentary"}' },
      { type: "text", text: `${text}ending` },
    ],
  };
  const event = { messages: [answer, inbound, { role: "toolResult", content: "tool data" }, final] };

  replies.agentEnd(event);
  expect(queued).toEqual([]);
  persist(final);
  replies.agentEnd(event);
  replies.agentEnd(event);

  expect(queued).toEqual([[text, "ending"]]);
});

test.each([
  ["a newer local input", { role: "user", content: "local input" }],
  ["an unrelated monitor input", { role: "custom", customType: "dori-monitor", content: "other message" }],
  ["another extension's hidden prompt", { role: "custom", customType: "other-extension", display: false }],
])("drops the reply after %s supersedes the Discord input", (_label, other) => {
  const { replies, inbound, persist, queued } = delivery();
  persist();

  replies.agentEnd({ messages: [inbound, other, answer] });
  replies.agentEnd({ messages: [inbound, answer] });

  expect(queued).toEqual([]);
});

test("a text-identical replay and a later run cannot claim a delivery receipt", () => {
  const { replies, inbound, persist, queued } = delivery();
  persist();

  replies.agentEnd({ messages: [{ ...inbound, timestamp: 1 }, answer] });
  expect(queued).toEqual([]);
  replies.agentStart();
  replies.agentEnd({ messages: [inbound, answer] });

  expect(queued).toEqual([]);
});

test.each([
  ["an aborted stop", { ...answer, stopReason: "aborted" }],
  ["a tool call", { ...answer, content: [...answer.content, { type: "toolCall" }] }],
  ["thinking without public text", { ...answer, content: [{ type: "thinking", thinking: "private" }] }],
])("does not publish %s", (_label, final) => {
  const { replies, inbound, persist, queued } = delivery();
  persist();

  replies.agentEnd({ messages: [inbound, answer, final] });

  expect(queued).toEqual([]);
});

test("a continuing turn cannot publish a stale assistant message from its active transcript", () => {
  const { replies, inbound, persist, queued } = delivery();
  persist();

  replies.agentEnd({ messages: [inbound, answer], willContinue: true });
  expect(queued).toEqual([]);
  replies.agentStart();
  replies.agentEnd({ messages: [inbound, answer] });

  expect(queued).toEqual([]);
});

test("an exact native continuation can finish with a fresh answer", () => {
  const { replies, inbound, persist, queued } = delivery();
  const final = { ...answer, timestamp: 21, content: [{ type: "text", text: "continued answer" }] };
  persist(final);

  replies.agentEnd({ messages: [inbound, answer], willContinue: true });
  replies.agentStart();
  replies.agentEnd({ messages: [inbound, answer, final] });

  expect(queued).toEqual([["continued answer"]]);
});

test("replaying a continuation settle cannot authorize a later unrelated run", () => {
  const { replies, inbound, persist, queued } = delivery();
  persist();
  const continuing = { messages: [inbound, answer], willContinue: true };
  const unrelated = { ...answer, timestamp: 21, content: [{ type: "text", text: "another run" }] };

  replies.agentEnd(continuing);
  replies.agentStart();
  replies.agentEnd(continuing);
  replies.agentStart();
  replies.agentEnd({ messages: [inbound, unrelated] });

  expect(queued).toEqual([]);
});

test("an exact native settle waits for dispatch acceptance before queuing its reply", () => {
  const { replies, inbound, persist, queued, receipt } = delivery(false);
  persist();
  replies.agentEnd({ messages: [inbound, answer] });
  expect(queued).toEqual([]);

  replies.acceptNative(receipt);

  expect(queued).toEqual([["visible answer"]]);
});

test("a settled answer from another branch does not become a public reply", () => {
  const { replies, inbound, persist, queued } = delivery();
  persist({ ...answer, content: [{ type: "text", text: "different branch answer" }] });

  replies.agentEnd({ messages: [inbound, answer] });

  expect(queued).toEqual([]);
});

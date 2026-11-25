import { expect, test } from "bun:test";
import { startup, telegramStartupToken } from "./telegram-startup-setup.ts";

const posix = test.skipIf(process.platform === "win32");

posix("Telegram inbound authenticates and checks an empty webhook before READY and the first poll", async () => {
  const r = await startup();
  expect([r.code, r.err, r.methods]).toEqual([0, "", ["getMe", "getWebhookInfo", "getUpdates"]]);
  expect(r.requests[0]?.params).toEqual({});
  expect(r.requests[1]?.params).toEqual({});
  expect(r.requests[2]?.params["offset"]).toBe(17);
  expect(r.out.indexOf("STARTUP_RESPONSE getWebhookInfo")).toBeLessThan(r.out.indexOf("INBOUND_READY telegram"));
  expect(r.out.indexOf("INBOUND_READY telegram")).toBeLessThan(r.out.indexOf("STARTUP_REQUEST getUpdates"));
  expect(r.offset).toBe("17");
});

posix("Telegram fills only missing bot profile fields before polling", async () => {
  const empty = { identity: { id: 222, is_bot: true, first_name: "" }, photos: { total_count: 0, photos: [] } };
  const custom = {
    identity: { id: 222, is_bot: true, first_name: "Selected Bot" },
    photos: { total_count: 1, photos: [[{ file_id: "existing" }]] },
  };
  const added = await startup(empty);
  expect([added.code, added.err]).toEqual([0, ""]);
  expect(added.requests.slice(2, 5)).toEqual([
    { method: "setMyName", params: { name: "Cataly" } },
    { method: "getUserProfilePhotos", params: { user_id: 222, limit: 1 } },
    { method: "setMyProfilePhoto", params: { photo: '{"type":"static","photo":"attach://avatar"}' } },
  ]);
  expect(added.methods.at(-1)).toBe("getUpdates");
  const kept = await startup(custom);
  expect([kept.code, kept.err, kept.methods]).toEqual([
    0,
    "",
    ["getMe", "getWebhookInfo", "getUserProfilePhotos", "getUpdates"],
  ]);
  const disabled = await startup(empty, undefined, { CATALY_MESSENGER_PROFILE_DEFAULTS: "off" });
  expect([disabled.code, disabled.err, disabled.methods]).toEqual([0, "", ["getMe", "getWebhookInfo", "getUpdates"]]);
});

posix("opt-in Telegram recall uses only the authenticated bot and verified owner messages", async () => {
  const message = (message_id: number, owner: number, text: string) => ({
    message_id,
    from: { id: owner, is_bot: false },
    chat: { id: 7, type: "private" },
    text,
  });
  const updates = [
    { update_id: 17, message: message(21, 7, "delivery marker earlier") },
    { update_id: 18, message: message(22, 8, "other owner marker") },
    { update_id: 19, message: message(23, 7, "what was the delivery marker earlier?") },
  ];
  const r = await startup({ recall: true, updates }, ["inbound", "telegram", "--loop", "0"]);
  expect([r.code, r.err, r.offset]).toEqual([0, "", "20"]);
  const prefix = "INBOUND_RECALL telegram 7 23 ";
  const line = r.out.split("\n").find((value) => value.startsWith(prefix));
  expect(JSON.parse(line?.slice(prefix.length) ?? "null").rows).toMatchObject([
    { role: "owner", text: "delivery marker earlier" },
  ]);
  expect(r.out).not.toContain("other owner marker");
});

posix("Telegram sends only record in the configured verified conversation", async () => {
  const send = (chat: string, recall: boolean) =>
    startup({ recall, sent: { message_id: 81 } }, ["send", "telegram", "--to", chat, "--text", "reply marker"]);
  for (const [chat, recall, stored] of [
    ["7", true, true],
    ["8", true, false],
    ["7", false, false],
  ] as const) {
    const result = await send(chat, recall);
    expect([result.code, result.err, result.recallStored]).toEqual([0, "", stored]);
    expect(result.out).toContain("SENT 81");
    expect(result.methods).toEqual(stored ? ["sendMessage", "getMe"] : ["sendMessage"]);
  }
});

posix(
  "an active webhook exits even in loop mode without polling, ACK, readiness or webhook mutation",
  async () => {
    const r = await startup({ webhook: { url: "https://private-webhook.invalid/key", pending_update_count: 0 } }, [
      "inbound",
      "telegram",
      "--loop",
      "1",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("active webhook");
    expect(r.err).not.toContain("private-webhook");
    expect(r.out).not.toContain("INBOUND_READY");
    expect(r.methods).toEqual(["getMe", "getWebhookInfo"]);
    expect(r.offset).toBe("17");
  },
  10_000,
);

posix.each([
  null,
  {},
  { id: 0, is_bot: true },
  { id: -1, is_bot: true },
  { id: "222", is_bot: true },
  { id: Number.MAX_SAFE_INTEGER + 1, is_bot: true },
  { id: 222, is_bot: false },
])("an invalid authenticated bot identity fails closed: %j", async (identity) => {
  const r = await startup({ identity });
  expect(r.code).toBe(1);
  expect(r.err).toContain("bot identity");
  expect(r.methods).toEqual(["getMe"]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.offset).toBe("17");
});

posix.each([null, {}, { url: null }, { url: 0 }])("an invalid webhook status fails closed: %j", async (webhook) => {
  const r = await startup({ webhook });
  expect(r.code).toBe(1);
  expect(r.err).toContain("webhook status");
  expect(r.methods).toEqual(["getMe", "getWebhookInfo"]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.offset).toBe("17");
});

posix.each(["getMe", "getWebhookInfo"])(
  "a rejected %s startup request never polls or exposes API secrets",
  async (method) => {
    for (const mode of ["failure", "reject"]) {
      const r = await startup({ [mode]: method });
      expect(r.code).toBe(1);
      expect(r.methods).toEqual(method === "getMe" ? ["getMe"] : ["getMe", "getWebhookInfo"]);
      expect(r.err).not.toContain(telegramStartupToken);
      expect(r.err).not.toContain("private-webhook");
      expect(r.out).not.toContain("INBOUND_READY");
      expect(r.offset).toBe("17");
    }
  },
);

posix.each(["getMe", "getWebhookInfo"])("READY and polling remain closed while %s is pending", async (hold) => {
  const r = await startup({ hold, release: true });
  expect(r.held).toContain(`STARTUP_WAIT ${hold}`);
  expect(r.held).not.toContain("INBOUND_READY");
  expect(r.held).not.toContain("STARTUP_REQUEST getUpdates");
  expect([r.code, r.err, r.methods]).toEqual([0, "", ["getMe", "getWebhookInfo", "getUpdates"]]);
});

posix.each(["getMe", "getWebhookInfo"])("stopping a pending %s startup never starts polling or ACK", async (hold) => {
  const r = await startup({ hold });
  expect(r.held).toContain(`STARTUP_WAIT ${hold}`);
  expect(r.code).not.toBe(0);
  expect(r.methods).toEqual(hold === "getMe" ? ["getMe"] : ["getMe", "getWebhookInfo"]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.offset).toBe("17");
});

posix("invalid local configuration is refused before even the startup read requests", async () => {
  const r = await startup({}, undefined, { CATALY_TELEGRAM_OWNER_ID: "not-an-integer" });
  expect(r.code).toBe(1);
  expect(r.methods).toEqual([]);
  expect(r.out).not.toContain("INBOUND_READY");
});

posix("Telegram intake refuses on Windows before any request or cursor change", async () => {
  const r = await startup({}, undefined, { CATALY_TEST_PLATFORM: "win32" });
  expect([r.code, r.err, r.methods]).toEqual([1, "Telegram intake is not supported on Windows\n", []]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.offset).toBe("17");
});

posix.each([["--version"], ["inbound-lag"]])("an offline command never activates Telegram: %j", async (command) => {
  const r = await startup({}, [command]);
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
  if (command === "inbound-lag") expect(r.out).toContain("LAG n=1");
  expect(r.methods).toEqual([]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.offset).toBe("17");
});

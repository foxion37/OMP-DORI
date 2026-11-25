import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { owedFile } from "../src/inbox-files.ts";
import { flushInbox } from "../src/inbox.ts";
import { lockInboxFiles, lockRoute, spoolMessage } from "../src/inbox-spool.ts";
import { HeadlessRuntime, headlessArgv } from "../src/runtime/headless.ts";
import { writePrivate } from "../src/runtime/headless-record.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

test.skipIf(process.platform === "win32")(
  "partial native start is retained until exact stop evidence exists",
  async () => {
    const d = new World().deps();
    const stateDir = join(d.store.root, "state");
    const rt = new HeadlessRuntime(stateDir);
    const inventory = join(d.store.root, "harness-native.json");
    try {
      const ref = await rt.create({ name: "lead", role: "lead", cwd: d.store.root, env: {} });
      const dir = join(stateDir, "headless", ref.id);
      writePrivate(inventory, { version: 1, stateDir, roles: { lead: { ref } } });
      await expect(up(d, d.store.root)).rejects.toThrow("already registered or held");
      const marker = join(dir, "started");
      writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
      await expect(main(["stop"], d)).rejects.toThrow("identity is unconfirmed");
      expect(existsSync(inventory)).toBe(true);
      expect(existsSync(join(dir, "stopped.json"))).toBe(false);

      // A broker that exits normally writes an owner-only stop receipt; stop never signals a PID from disk.
      writePrivate(join(dir, "stopped.json"), {});
      const queued = { at: d.now(), from: "operator", text: "recover this queued message" };
      d.store.setRole("lead", ref);
      writePrivate(inventory, { version: 1, stateDir, roles: { lead: { ref, sessionId: "owned-session" } } });
      d.store.saveInbox(ref, [queued]);
      expect((await captureIo(() => main(["stop"], d))).out).toInclude("STOPPED native harness");
      expect(existsSync(inventory)).toBe(false);
      expect(d.store.queued(ref)).toEqual([queued]);
      expect(await flushInbox(d, ref)).toBe("held");
      expect((await captureIo(() => main(["inbox", "list", `headless:${ref.id}`], d))).out).toInclude(queued.text);
    } finally {
      rmSync(d.store.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([
  ["queued", "pending inbox"],
  ["spool", "pending inbox"],
  ["ambiguous", "pending inbox"],
  ["owed", "pending inbox"],
  ["route", "inbox route is in use"],
  ["flush", "inbox flush is in progress"],
] as const)("native stop preserves the duty controller while the lead inbox has %s", async (kind, reason) => {
  const d = new World().deps();
  const root = d.store.root;
  const stateDir = join(root, "state");
  const rt = new HeadlessRuntime(stateDir);
  let unlock: (() => void) | undefined;
  try {
    const lead = await rt.create({ name: "lead", role: "lead", cwd: root, env: {} });
    const loop = await rt.create({ name: "duty-loop", role: "duty-loop", cwd: root, env: {} });
    d.store.setRole("lead", lead);
    d.store.setRole("duty-loop", loop);
    writePrivate(join(root, "harness-native.json"), {
      version: 1,
      stateDir,
      roles: { lead: { ref: lead, sessionId: "owned-session" }, "duty-loop": { ref: loop } },
    });
    const msg = { at: d.now(), from: "operator", text: "do not strand this" };
    switch (kind) {
      case "queued":
        d.store.saveInbox(lead, [msg]);
        break;
      case "spool":
        spoolMessage(d.store.inboxPath(lead), msg);
        break;
      case "ambiguous":
        d.store.saveInbox(lead, [{ ...msg, attempt: { at: d.now(), state: "ambiguous", detail: "unconfirmed" } }]);
        break;
      case "owed":
        spoolMessage(owedFile(root), msg);
        break;
      case "route":
        unlock = lockRoute(root, lead, d.now());
        expect(unlock).toBeDefined();
        break;
      case "flush":
        unlock = lockInboxFiles(root, lead, d.now());
        expect(unlock).toBeDefined();
        break;
    }
    await expect(main(["stop"], d)).rejects.toThrow(reason);
    expect(d.store.roles()).toEqual({ lead, "duty-loop": loop });
    expect(existsSync(join(stateDir, "headless", loop.id, "stopped.json"))).toBe(false);
    if (kind === "ambiguous") {
      await main(["inbox", "ack", "lead", "1"], d);
      expect((await captureIo(() => main(["stop"], d))).out).toInclude("STOPPED native harness");
      await expect(main(["send", `headless:${lead.id}`, "--text", "stale address"], d)).rejects.toThrow(
        "closed to new messages",
      );
      expect(d.store.queued(lead)).toEqual([]);
    }
  } finally {
    unlock?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("native stop and send refuse unowned role registrations", async () => {
  const base = new World().deps();
  const root = base.store.root;
  const stateDir = join(root, "state");
  const rt = new HeadlessRuntime(stateDir);
  const d = {
    ...base,
    runtimes: new Runtimes("headless", () => rt),
  };
  try {
    const lead = await rt.create({ name: "lead", role: "lead", cwd: root, env: {} });
    const duty = await rt.create({ name: "duty", role: "duty", cwd: root, env: {} });
    const ghost = await rt.create({ name: "lead", role: "lead", cwd: root, env: {} });
    const terminal = { runtime: "tern", id: "7" } as const;
    d.store.setRole("lead", lead);
    d.store.setRole("duty", duty);
    d.store.setRole("duty-loop", terminal);
    writePrivate(join(root, "harness-native.json"), {
      version: 1,
      stateDir,
      roles: { lead: { ref: lead } },
    });
    await expect(main(["stop"], d)).rejects.toThrow("registration is not owned");
    await expect(main(["send", "duty", "--text", "unowned"], d)).rejects.toThrow("no owned native role binding");
    await expect(main(["send", "duty-loop", "--text", "unowned"], d)).rejects.toThrow("no owned native role binding");
    await expect(main(["send", `headless:${lead.id}`, "--text", "partial"], d)).rejects.toThrow(
      "no matching verified native role",
    );
    await expect(main(["observe", `headless:${ghost.id}`], d)).rejects.toThrow("no owned native role binding");
    await expect(main(["send", `headless:${ghost.id}`, "--text", "unpublished"], d)).rejects.toThrow(
      "no owned native role binding",
    );
    expect(d.store.inboxPanes()).toEqual([]);
    expect(d.store.roles()).toEqual({ lead, duty, "duty-loop": terminal });
    expect(existsSync(join(stateDir, "headless", lead.id, "stopped.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harness role argv is idle and preserves trusted native option boundaries", () => {
  expect(headlessArgv(["omp", "--cataly-role", "lane", "--model", "{model}", "{prompt}"], "p/m", "lead")).toEqual([
    "omp",
    "--model",
    "p/m",
    "--cataly-role",
    "cataly",
  ]);
  for (const options of [
    ["unexpected initial turn"],
    ["--cataly-role=lane", "--cataly-role=cataly"],
    ["--mode=rpc"],
    ["--cwd=elsewhere"],
    ["--plan-yolo"],
  ])
    expect(() => headlessArgv(["omp", ...options, "{prompt}"], "p/m", "duty")).toThrow();
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import type { Deps } from "../src/harness.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { TernRuntime } from "../src/runtime/tern/index.ts";
import { block, type FakeBlock, FakeTern, ZSH } from "./fake-tern.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

// The terminal harness paths Tern keeps: `up` on a Tern runtime, hand-registered roles, their retirement on `stop`,
// and the operator's `send --to-shell`.

function ternHome(initial: Record<string, FakeBlock> = {}) {
  const fake = new FakeTern(initial);
  const tern = new TernRuntime(fake.exec, { env: {}, sleep: async () => {} });
  const base = new World().deps({ runtime: "tern" });
  const d: Deps = { ...base, runtimes: new Runtimes("tern", () => tern) };
  return { fake, d };
}

describe("cataly harness up on Tern", () => {
  test("lead opens a session, duty a tab in it, the loops split below; all four roles registered", async () => {
    const { fake, d } = ternHome();
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    // The lead's new session (8000) is the group the duty tab opens in.
    expect(fake.calls.filter((c) => ["new", "split"].includes(c[0] ?? "")).map((c) => c.slice(0, 4))).toEqual([
      ["new", "session", "cataly", "--cwd"],
      ["new", "tab", "8000", "--cwd"],
      ["split", "8003", "down", "--cwd"],
      ["split", "8005", "down", "--cwd"],
    ]);
    expect(fake.ran.map((r) => [r.id, r.command])).toEqual([
      ["8001", `omp --cataly-role cataly --append-system-prompt '${join(d.store.root, "prompts", "lead.md")}'`],
      ["8003", `omp --cataly-role cataly --append-system-prompt '${join(d.store.root, "prompts", "duty.md")}'`],
      ["8005", "cataly duty --interval 60"],
      ["8007", "cataly loop"],
    ]);
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({
      lead: "tern:8001",
      duty: "tern:8003",
      "duty-loop": "tern:8005",
      "hourly-loop": "tern:8007",
    });
    expect(out).toBe(
      `UP runtime=tern lead=tern:8001 duty=tern:8003 loop=tern:8005 hourly=tern:8007 home=${d.store.root}`,
    );
    await expect(up(d, "/w")).rejects.toThrow("this home already has registered roles");
  });
});

describe("hand-registered Tern roles", () => {
  test("role registers a Tern ref; non-refs and headless refs are refused", async () => {
    const { d } = ternHome();
    expect((await captureIo(() => main(["role", "lead", "tern:42"], d))).out).toBe("ROLE lead=tern:42");
    expect(d.store.roles().lead).toEqual({ runtime: "tern", id: "42" });
    await expect(main(["role", "duty", "42"], d)).rejects.toThrow("42 is not a session ref (tern:42)");
    await expect(main(["role", "duty", "tern:abc"], d)).rejects.toThrow("is not a session ref");
    await expect(main(["role", "duty", "headless:00000000-0000-4000-8000-000000000001"], d)).rejects.toThrow(
      "registered by cataly harness up",
    );
  });

  test("stop retires the registrations only once every Tern block is gone, and never closes one", async () => {
    const { fake, d } = ternHome({ "42": block() });
    d.store.setRole("lead", { runtime: "tern", id: "42" });
    await expect(main(["stop"], d)).rejects.toThrow("Terminal roles left unchanged: tern:42 is still present");
    expect(d.store.roles().lead).toEqual({ runtime: "tern", id: "42" });
    expect(fake.calls.some((c) => c[0] === "close")).toBe(false);
    fake.blocks.delete("42");
    const { out } = await captureIo(() => main(["stop"], d));
    expect(out).toBe("STOPPED retired 1 already-gone terminal role registration(s)");
    expect(d.store.roles()).toEqual({});
  });
});

describe("send --to-shell", () => {
  test("types into a Tern block whose shell is in front; an agent in front takes the queued agent path", async () => {
    const { fake, d } = ternHome({
      "42": block({ foreground: ZSH, draft: undefined }),
      "43": block({ working: true }),
    });
    const shell = await captureIo(() => main(["send", "tern:42", "--to-shell", "--text", "ls"], d));
    expect(shell).toEqual({ code: 0, out: "DELIVERED tern:42" });
    expect(fake.ran).toEqual([{ id: "42", command: "ls" }]);
    const agent = await captureIo(() => main(["send", "tern:43", "--to-shell", "--text", "ls"], d));
    expect(agent).toEqual({ code: 0, out: "QUEUED tern:43" });
    expect(d.store.queued({ runtime: "tern", id: "43" }).map((m) => m.text)).toEqual(["ls"]);
  });
});

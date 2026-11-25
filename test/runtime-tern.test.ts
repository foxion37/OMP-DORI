import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { inboxFile, refOfInbox } from "../src/inbox-files.ts";
import { refText } from "../src/refs.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { TernRuntime } from "../src/runtime/tern/index.ts";
import { openSession, parseRef } from "../src/runtime/types.ts";
import { block, type FakeProc, OMP, ZSH } from "./fake-tern.ts";
import { B1, callsOf, lane, rig } from "./tern-rig.ts";

const LAUNCH = ["--cwd", "/w", "--", "env", "PI_TUI_NATIVE=0", "A=1", "B=it's a b", "/bin/zsh"];
const inTern = { env: { SHELL: "/bin/zsh", TERN_PANE: "5001" } };
describe("create / start / createGroup", () => {
  test("a tab in the caller's own session (TERN_PANE): env through `env`, classic renderer, user's shell, tab named", async () => {
    const { fake, rt } = rig({ "5001": block() }, inTern);
    const ref = await rt.create(lane);
    expect(callsOf(fake, "new")).toEqual([["new", "tab", "7001", ...LAUNCH]]);
    expect(ref).toEqual({ runtime: "tern", id: "8000", group: "7001", container: "8001" });
    expect(fake.blocks.get("8000")?.session).toBe("work");
    expect(callsOf(fake, "rename")).toEqual([["rename", "8000", "Lane K"]]);
    expect(fake.tabNames.get("8001")).toBe("Lane K");
  });

  test("the spec's group wins over the caller's session; a session name nothing holds is opened with the tab", async () => {
    const { fake, rt } = rig({ "5001": block() }, inTern);
    const ref = await rt.create({ ...lane, group: "lanes" });
    expect(callsOf(fake, "new")[0]).toEqual(["new", "session", "lanes", ...LAUNCH]);
    expect(ref.group).toBe(fake.sessions.get("lanes"));
    // The next session of that group joins it as a tab.
    await rt.create({ ...lane, name: "k2", group: "lanes" });
    expect(callsOf(fake, "new")[1]?.slice(0, 3)).toEqual(["new", "tab", String(fake.sessions.get("lanes"))]);
  });

  test("outside Tern with no group: the session named cataly", async () => {
    const { fake, rt } = rig();
    await rt.create(lane);
    expect(callsOf(fake, "new")[0]?.slice(0, 3)).toEqual(["new", "session", "cataly"]);
  });

  test("a group may be a session id; a numeric id no session has is refused, nothing opened", async () => {
    const { fake, rt } = rig();
    await rt.create({ ...lane, group: "7001" });
    expect(callsOf(fake, "new")[0]?.slice(0, 3)).toEqual(["new", "tab", "7001"]);
    await expect(rt.create({ ...lane, group: "999" })).rejects.toThrow("tern has no session 999");
    expect(callsOf(fake, "new")).toHaveLength(1);
  });

  test("workspace-root opens a new session under a free name; split-below splits near down; neither renames", async () => {
    const { fake, rt } = rig();
    fake.sessions.set("cataly", "7002");
    const lead = await rt.create({ ...lane, name: "cataly", container: "workspace-root" });
    expect(callsOf(fake, "new")[0]).toEqual(["new", "session", "cataly-2", ...LAUNCH]);
    const loop = await rt.create({ ...lane, container: "split-below", near: lead });
    expect(callsOf(fake, "split")).toEqual([["split", lead.id, "down", ...LAUNCH]]);
    expect(loop.group).toBe(lead.group);
    expect(callsOf(fake, "rename")).toEqual([]);
    await expect(rt.create({ ...lane, container: "split-below" })).rejects.toThrow("needs `near`");
  });

  test("the spec's env may set the renderer itself; no SHELL runs sh", async () => {
    const { fake, rt } = rig({}, { env: {} });
    await rt.create({ ...lane, env: { PI_TUI_NATIVE: "1" } });
    expect(callsOf(fake, "new")[0]?.slice(3)).toEqual(["--cwd", "/w", "--", "env", "PI_TUI_NATIVE=1", "sh"]);
  });

  test("an env key that is not a shell variable name is refused before any call", async () => {
    const { fake, rt } = rig();
    await expect(rt.create({ ...lane, env: { "A B": "1" } })).rejects.toThrow("not a shell variable name");
    expect(fake.calls).toEqual([]);
  });

  test("a tab that cannot be named is closed again and the failure thrown", async () => {
    const { fake, rt } = rig();
    fake.knobs.renameError = "the name is not allowed";
    await expect(rt.create(lane)).rejects.toThrow("the name is not allowed");
    expect(callsOf(fake, "close")).toEqual([["close", "8001"]]);
    expect(fake.blocks.size).toBe(0);
  });

  test("openSession starts the command with `tern run <id> -- <command>`", async () => {
    const { fake, rt } = rig();
    const ref = await openSession(rt, lane, "omp --cataly-role lane 'go'");
    expect(fake.ran).toEqual([{ id: ref.id, command: "omp --cataly-role lane 'go'" }]);
    expect(callsOf(fake, "run")).toEqual([["run", ref.id, "--", "omp --cataly-role lane 'go'"]]);
  });

  test("createGroup is the caller's own session id, else the label, and opens nothing", async () => {
    const inside = rig({ "5001": block() }, inTern);
    expect(await inside.rt.createGroup("cataly", "/w")).toBe("7001");
    const outside = rig();
    expect(await outside.rt.createGroup("cataly", "/w")).toBe("cataly");
    expect([...callsOf(inside.fake, "new"), ...callsOf(outside.fake, "new")]).toEqual([]);
  });
});

describe("probe", () => {
  test.each([
    ["omp in front, Tern not busy", block(), "idle"],
    ["omp in front, Tern busy", block({ working: true }), "working"],
    ["a shell in front (agent exited or suspended)", block({ foreground: ZSH }), "shell"],
    ["no foreground Tern can name (doubt reads as a shell)", block({ foreground: null }), "shell"],
    ["another program in front", block({ foreground: { pid: 7, name: "vim", argv: ["vim"] } }), "unknown"],
    ["a block kept open after its program exited", block({ live: false }), "gone"],
    ["a note block (a file, no program)", block({ file: "/w/notes.md" }), "gone"],
  ] as const)("%s: %s", async (_, b, status) => {
    const { rt } = rig({ "5001": b });
    expect((await rt.probe(B1)).status).toBe(status);
  });

  test.each([
    ["the version as its process title, `omp` as argv[0]", OMP],
    ["the omp command by path", { pid: 101, name: "omp", argv: ["/synthetic/bin/omp"] }],
    [
      "the published CLI under bun",
      { pid: 101, name: "bun", argv: ["bun", "/synthetic/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"] },
    ],
  ] as const)("omp is recognised by %s", async (_, foreground) => {
    const { rt } = rig({ "5001": block({ foreground: { ...foreground, argv: [...foreground.argv] } }) });
    expect(await rt.probe(B1)).toMatchObject({ status: "idle", agent: "omp" });
  });

  test.each([undefined, null, "zsh", ["zsh", null], []].map((argv) => ({ argv })))(
    "incomplete argv keeps hints without claiming a complete observation: %p",
    async ({ argv }) => {
      const foreground = { pid: 100, name: "zsh", argv } as unknown as FakeProc;
      const seen = await rig({ "5001": block({ foreground }) }).rt.probe(B1);
      const expected =
        Array.isArray(argv) && argv.length === 0
          ? { name: "zsh", pid: 100, argv: [] }
          : { name: "zsh", pid: 100, argv: ["zsh"], argvIncomplete: true };
      expect(seen.foreground).toEqual([expected]);
      expect(seen.shellInFront).toBe(true);
    },
  );

  test("the snapshot carries the foreground, its group, the block's shell as root, title and cwd", async () => {
    const { rt } = rig({ "5001": block() });
    expect(await rt.probe(B1)).toEqual({
      status: "idle",
      agent: "omp",
      pgid: OMP.pid,
      rootPid: ZSH.pid,
      title: "π > w",
      cwd: "/w",
      shellInFront: false,
      foreground: [{ name: OMP.name, argv: OMP.argv, pid: OMP.pid }],
    });
  });

  test("a shell in front names no agent", async () => {
    const seen = await rig({ "5001": block({ foreground: ZSH }) }).rt.probe(B1);
    expect(seen.shellInFront).toBe(true);
    expect(seen.agent).toBeUndefined();
  });

  test("an unknown block is gone; any other process failure throws", async () => {
    const { fake, rt } = rig({ "5001": block() });
    expect((await rt.probe({ runtime: "tern", id: "42" })).status).toBe("gone");
    fake.knobs.processError = "daemon not running";
    await expect(rt.probe(B1)).rejects.toThrow("daemon not running");
  });
});

describe("list, close, self", () => {
  const window = () => {
    const r = rig({
      "5001": block(),
      "5002": block({ foreground: ZSH, tab: "9002" }),
      "5003": block({ live: false }),
      "5004": block({ file: "/w/notes.md" }),
      "6001": block({ session: "other", tab: "9100" }),
    });
    r.fake.sessions.set("other", "7100");
    r.fake.tabNames.set("9002", "Lane K");
    return r;
  };

  test("list without a group: every live terminal block of the window, with its status, tab name and place", async () => {
    const { fake, rt } = window();
    const listed = await rt.list();
    expect(listed.map((s) => [s.ref.id, s.status, s.agent, s.name])).toEqual([
      ["5001", "idle", "omp", undefined],
      ["5002", "shell", undefined, "Lane K"],
      ["6001", "idle", "omp", undefined],
    ]);
    expect(listed[0]).toEqual({
      ref: { runtime: "tern", id: "5001", group: "7001", container: "9001" },
      title: "π > w",
      cwd: "/w",
      status: "idle",
      agent: "omp",
    });
    // An exited block and a note block are never asked about.
    expect(callsOf(fake, "process").map((c) => c[1])).toEqual(["5001", "5002", "6001"]);
  });

  test("list with a group: that Tern session only, named by its name or its id; an unknown one lists nothing", async () => {
    const { rt } = window();
    expect((await rt.list({ group: "other" })).map((s) => s.ref.id)).toEqual(["6001"]);
    expect((await rt.list({ group: "7001" })).map((s) => s.ref.id)).toEqual(["5001", "5002"]);
    expect(await rt.list({ group: "nowhere" })).toEqual([]);
  });

  test("a block that goes between the listing and its probe is left out", async () => {
    const { fake } = window();
    // The block closes right as Tern is asked about its process.
    const rt = new TernRuntime(
      async (cmd, argv) => {
        if (argv[0] === "process" && argv[1] === "5002") fake.blocks.delete("5002");
        return fake.exec(cmd, argv);
      },
      { env: {} },
    );
    expect((await rt.list({ group: "7001" })).map((s) => s.ref.id)).toEqual(["5001"]);
  });

  test("close is `tern close` whatever the scope; a block already gone is closed", async () => {
    const { fake, rt } = rig({ "5001": block() });
    await rt.close(B1, "container");
    expect(fake.blocks.has("5001")).toBe(false);
    await rt.close(B1);
    expect(callsOf(fake, "close")).toEqual([
      ["close", "5001"],
      ["close", "5001"],
    ]);
  });

  test("self is TERN_PANE; registry selfAny reaches it unless a native lane ID is set", () => {
    expect(rig({}, { env: { TERN_PANE: "5001" } }).rt.self()).toEqual(B1);
    expect(rig({}, { env: { TERN_PANE: "x1" } }).rt.self() ?? rig().rt.self()).toBeUndefined();
    const rts = new Runtimes("tern", () => rig().rt);
    expect(rts.selfAny({ TERN_PANE: "5001" })).toEqual(B1);
    expect(rts.selfAny({})).toBeUndefined();
    const native = "00000000-0000-4000-8000-000000000001";
    expect(rts.selfAny({ TERN_PANE: "5001", CATALY_HEADLESS_ID: native })).toEqual({ runtime: "headless", id: native });
  });

  test("kind is tern; refs: tern:<digits> parses, a bare number is not a ref", () => {
    expect(rig().rt.kind).toBe("tern");
    expect(parseRef("tern:5001")).toEqual(B1);
    expect(parseRef("tern:t1")).toBeUndefined();
    expect(parseRef("5001")).toBeUndefined();
    expect(refText(B1)).toBe("tern:5001");
  });

  test("a tern inbox file reads back as the tern block", () => {
    expect(inboxFile("/state", B1)).toBe(join("/state", "inbox", "tern--5001.jsonl"));
    expect(refOfInbox("tern--5001.jsonl")).toEqual(B1);
  });
});

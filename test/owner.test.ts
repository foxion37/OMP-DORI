import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { fill, prompt, promptFile, rolePrompt } from "../src/harness.ts";
import { OWNER_PROFILE_MAX_BYTES, ownerPaths, ownerPromptSection, snapshotPath, TEMPLATE } from "../src/owner.ts";
import { checkOwner } from "../src/owner-check.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const NOON = new Date(2026, 10, 20, 12, 0).getTime();

function home() {
  const w = new World();
  w.clock = NOON;
  // `up` writes the role prompts only on a terminal runtime; the native harness passes them by argv.
  const d = w.deps({ runtime: "tern" });
  const paths = ownerPaths(d.store.root);
  const write = (body: Partial<Record<string, string[]>>) =>
    writeFileSync(
      paths.profile,
      [
        "# Owner profile",
        ...["Preferences", "Current interests", "Decisions", "Avoid", "Update log"].flatMap((s) => [
          "",
          `## ${s}`,
          ...(body[s] ?? []),
        ]),
      ].join("\n") + "\n",
    );
  const cli = (...argv: string[]) => captureIo(() => main(["owner", ...argv], d));
  return { w, d, paths, write, cli };
}

describe("owner profile in the lead's prompt", () => {
  test("retained operator prompts resolve the command placeholder without changing their files", () => {
    const { d } = home();
    const old = process.env["CATALY_PROMPTS_DIR"];
    const dir = d.store.root;
    const text = "{{cataly}} / {{unknown}}";
    expect(fill("{{cataly}} owner snapshot / {{unknown}}", { cataly: d.catalyCmd })).toBe(
      `${d.catalyCmd} owner snapshot / {{unknown}}`,
    );
    try {
      process.env["CATALY_PROMPTS_DIR"] = dir;
      for (const name of ["lead.md", "duty.md", "lane-footer.md"] as const) {
        writeFileSync(join(dir, name), text);
        const value = name === "lane-footer.md" ? prompt(name, { cataly: d.catalyCmd }) : rolePrompt(d, name);
        expect(value).toBe(`${d.catalyCmd} / {{unknown}}`);
        expect(readFileSync(join(dir, name), "utf8")).toBe(text);
      }
    } finally {
      if (old === undefined) delete process.env["CATALY_PROMPTS_DIR"];
      else process.env["CATALY_PROMPTS_DIR"] = old;
    }
  });

  test("off by default: no file leaves the lead and duty prompts exactly as the templates", () => {
    const { d } = home();
    expect(ownerPromptSection(d.store.root)).toBeUndefined();
    for (const name of ["lead.md", "duty.md"] as const)
      expect(rolePrompt(d, name)).toBe(fill(readFileSync(promptFile(name), "utf8"), { cataly: "cataly" }));
  });

  test("lead startup references the local profile without copying its contents into the system prompt", async () => {
    const { d, write, cli } = home();
    write({ Preferences: ["- (2026-11-19) Conclusion first."], Decisions: ["- (2026-11-18) Merge without asking."] });
    const lead = rolePrompt(d, "lead.md");
    expect(lead).toContain("cataly owner show");
    expect(lead).not.toContain("Conclusion first.");
    expect(lead).not.toContain("Merge without asking.");
    expect((await cli("show")).out).toContain("Conclusion first.");
    expect(rolePrompt(d, "duty.md")).not.toContain("cataly owner show");
    await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(readFileSync(join(d.store.root, "prompts", "lead.md"), "utf8")).toBe(lead);
    expect(readFileSync(join(d.store.root, "prompts", "duty.md"), "utf8")).not.toContain("Owner profile");
  });

  test("a profile over 16 KB is cut at a line boundary and says so", () => {
    const { d, write } = home();
    const lines = Array.from({ length: 400 }, (_, i) => `- (2026-11-19) observation ${i} ${"x".repeat(40)}`);
    write({ Preferences: lines });
    const section = ownerPromptSection(d.store.root)!;
    const body = section.slice(section.indexOf("\n# Owner profile") + 1, section.lastIndexOf("\n\n(cut at"));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(OWNER_PROFILE_MAX_BYTES);
    expect(body.split("\n").at(-1)).toMatch(/^- \(2026-11-19\) observation \d+ x{40}$/);
    expect(section).not.toContain("observation 399 ");
    expect(section).toContain(`(cut at ${OWNER_PROFILE_MAX_BYTES} bytes;`);
  });
});

describe("owner check", () => {
  test("the template passes; structure, format, dates, size and secrets are each reported", () => {
    const { d, paths, write } = home();
    writeFileSync(paths.profile, TEMPLATE);
    expect(checkOwner(d.store.root, NOON)).toEqual([]);
    write({
      Preferences: ["Conclusion first.", "- (2026-12-01) from the future"],
      "Current interests": ["- (2026-11-01) old topic", "- (2026-11-10) recent topic"],
      Avoid: [`- (2026-11-19) token ${["xo", "xb-", "1".repeat(12)].join("")}, mail a@b.example`],
      "Update log": Array.from({ length: 15 }, () => "- (2026-11-19) added 0, changed 0, removed 0, archived 0"),
    });
    const problems = checkOwner(d.store.root, NOON).join("\n");
    expect(problems).toContain('Preferences: not "- (YYYY-MM-DD) text": Conclusion first.');
    expect(problems).toContain("Preferences: dated after today");
    expect(problems).toContain("Current interests: not seen for over 14 days, remove it: - (2026-11-01) old topic");
    expect(problems).not.toContain("recent topic");
    expect(problems).toContain("contains a Slack token");
    expect(problems).toContain("contains an e-mail address");
    expect(problems).toContain("Update log: 15 lines, keep the newest 14");
    writeFileSync(paths.profile, `${TEMPLATE}\n## Notes\n- (2026-11-19) ${"y".repeat(OWNER_PROFILE_MAX_BYTES)}\n`);
    const shape = checkOwner(d.store.root, NOON).join("\n");
    expect(shape).toContain("sections must be exactly, in order");
    expect(shape).toContain(`is over ${OWNER_PROFILE_MAX_BYTES}`);
  });

  test("a decision in today's snapshot must survive: kept, quoted as replaced, or archived", () => {
    const { d, paths, write } = home();
    const old = [
      "- (2026-11-01) Lanes use model A.",
      "- (2026-11-02) Ask before night merges.",
      "- (2026-11-03) Use tool T.",
    ];
    write({ Decisions: old });
    mkdirSync(paths.history, { recursive: true });
    writeFileSync(snapshotPath(d.store.root, "2026-11-20"), readFileSync(paths.profile));
    write({ Decisions: ["- (2026-11-20) Lanes use model B. (replaces: Lanes use model A.)"] });
    const lost = checkOwner(d.store.root, NOON);
    expect(lost.filter((p) => p.includes("lost since today's snapshot"))).toHaveLength(2);
    writeFileSync(paths.archive, `- (moved 2026-11-20) ${old[1]} - oldest\n`);
    write({ Decisions: ["- (2026-11-20) Lanes use model B. (replaces: Lanes use model A.)", old[2]!] });
    expect(checkOwner(d.store.root, NOON)).toEqual([]);
  });

  const decision = "Use tool T.";
  const original = `- (2026-11-01) ${decision}`;
  test.each([
    ["refreshed date", decision, "", true],
    ["larger live entry", `Tentatively ${decision} Review again.`, "", false],
    ["replacement field", `Use tool U. (replaces: ${decision})`, "", true],
    ["larger replacement field", `Use tool U. (replaces: Earlier: ${decision})`, "", false],
    ["nested note inside an unclosed field", `Use tool U. (aside (replaces: ${decision})`, "", false],
    ["nonterminal note", `Use tool U. (replaces: ${decision}) Tentative.`, "", false],
    ["first conflict side", `CONFLICT: ${decision} / Use tool U.`, "", true],
    ["second conflict side", `CONFLICT: Use tool U. / ${decision}`, "", true],
    ["larger conflict side", `CONFLICT: Start here: ${decision} / Use tool U.`, "", false],
    ["ambiguous conflict", `CONFLICT: Use tool V. / ${decision} / Use tool U.`, "", false],
    ["original archived", "", `- (moved 2026-11-20) ${original} - oldest`, true],
    ["standalone dated archive entry", "", original, true],
    ["same text archived with a different date", "", `- (moved 2026-11-20) - (2026-11-02) ${decision} - oldest`, false],
    ["archive explanation only", "", `- (moved 2026-11-20) - (2026-11-02) Use tool U. - Earlier: ${decision}`, false],
    ["archive prose only", "", `The resulting decision: ${decision}`, false],
    ["ambiguous wrapped archive", "", `- (moved 2026-11-20) ${original} - only on weekdays - oldest`, false],
  ] as const)("checks whole decision retention: %s", async (_name, current, archive, retained) => {
    const { paths, cli, write } = home();
    write({ Decisions: [original] });
    await cli("snapshot");
    write({ Decisions: current ? [`- (2026-11-20) ${current}`] : [] });
    if (archive) writeFileSync(paths.archive, `${archive}\n`);

    const { code, out } = await cli("check");

    expect(code).toBe(retained ? 0 : 1);
    if (retained) expect(out).toStartWith("OWNER_OK ");
    else expect(out).toContain("lost since today's snapshot");
  });

  test("a replacement can quote a previous replacement, and a delimiter can be archived verbatim", () => {
    const { d, paths, write } = home();
    const prior = `Use tool U. (replaces: ${decision})`;
    const archived = "- (2026-11-02) Do not use tool V - except on weekdays.";
    write({ Decisions: [`- (2026-11-01) ${prior}`, archived] });
    mkdirSync(paths.history);
    writeFileSync(snapshotPath(d.store.root, "2026-11-20"), readFileSync(paths.profile));
    write({ Decisions: [`- (2026-11-20) Use tool W. (replaces: ${prior})`] });
    writeFileSync(paths.archive, `${archived}\n`);

    expect(checkOwner(d.store.root, NOON)).toEqual([]);
  });
});

describe("cataly harness owner", () => {
  test("show, init, snapshot, diff and revert; check exits 1 on a problem", async () => {
    const { w, paths, cli } = home();
    expect((await cli("show")).out).toStartWith("NO_OWNER_PROFILE ");
    await expect(cli("snapshot")).rejects.toThrow("cataly harness owner init creates one");
    expect((await cli("init")).out).toStartWith(`OWNER_INIT ${paths.profile}`);
    await expect(cli("init")).rejects.toThrow("exists");
    expect(await cli("check")).toEqual({ code: 0, out: `OWNER_OK ${TEMPLATE.length} bytes` });
    expect((await cli("snapshot")).out).toBe(`SNAPSHOT ${join(paths.history, "2026-11-20.md")}`);
    expect((await cli("snapshot")).out).toStartWith("SNAPSHOT_KEPT ");
    expect((await cli("diff")).out).toBe("NO_CHANGES since 2026-11-20");
    writeFileSync(paths.profile, TEMPLATE.replace("## Avoid\n", "## Avoid\n- (2026-11-20) Long preambles.\n"));
    expect((await cli("diff", "2026-11-20")).out).toBe("DIFF 2026-11-20 -> now\n+ - (2026-11-20) Long preambles.");
    writeFileSync(paths.profile, "no sections\n");
    expect((await cli("check")).code).toBe(1);
    w.clock += 60_000;
    const reverted = (await cli("revert", "2026-11-20")).out;
    expect(readFileSync(paths.profile, "utf8")).toBe(TEMPLATE);
    const saved = /Backup saved at (.+); undo with /.exec(reverted)![1]!;
    expect(readFileSync(saved, "utf8")).toBe("no sections\n");
    await expect(cli("revert", "2026-11-19")).rejects.toThrow("no owner snapshot for 2026-11-19");
    await expect(cli("diff", "yesterday")).rejects.toThrow("is not a date");
  });
});

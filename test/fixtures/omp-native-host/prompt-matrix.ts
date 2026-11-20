import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_INVARIANTS } from "../../../extension/role-invariants.ts";

const [root, cwd] = process.argv.slice(2);
assert(
  root && cwd && process.env["OMP_ULW_SCOPE_FILE"] && process.env["DORI_TEST_OMP_ROOT"] && process.env["DORI_CONFIG"],
);
let networkAttempts = 0;
const forbiddenNetwork = (): never => {
  networkAttempts++;
  throw new Error("Native prompt matrix must not make a network request");
};
globalThis.fetch = Object.assign(async () => forbiddenNetwork(), { preconnect: forbiddenNetwork });
// Static imports would evaluate native modules before the network guard.
const { nativeComposition, SOL_MODEL } = await import("./compose.ts");
// Keep verifier dependencies behind the guard as well; admit the local checkout before importing ULW.
const { assertSourceBundle, readSourceBundle } = await import("../../../src/release/source-bundle.ts");
const ulwRoot = realpathSync(join(root, "ref/omp-ulw"));
assertSourceBundle(ulwRoot, readSourceBundle(root), cwd);
const { renderPreset } = await import(join(ulwRoot, "presets.ts"));
assert.equal(typeof renderPreset, "function", "selected ULW source has no renderPreset");
const dori = join(root, "extension/index.ts");
const ulw = join(ulwRoot, "index.ts");
type Options = Parameters<typeof nativeComposition>[2];
const scenarios: Array<{
  name: string;
  role?: Options["role"];
  model?: Options["model"];
  prompt: string;
  child?: boolean;
  excludeModel?: boolean;
  excluded?: boolean;
  customPrompt?: string;
}> = [
  { name: "ordinary", prompt: "Describe the fixture." },
  {
    name: "user profile",
    role: "lane",
    prompt: "ulw inspect the fixture",
    customPrompt: "F67_USER_PROFILE: follow the user-selected working style exactly.",
  },
  { name: "lane normal", role: "lane", prompt: "Describe the fixture." },
  { name: "lane ULW", role: "lane", prompt: "ulw inspect the fixture" },
  { name: "lane specialized", role: "lane", prompt: "ulw-plan design the fixture" },
  { name: "Dori", role: "dori", prompt: "Describe the fixture." },
  { name: "child", role: "lane", prompt: "ulw inspect the fixture", child: true },
  {
    name: "Terra",
    role: "lane",
    prompt: "ulw inspect the fixture",
    model: { ...SOL_MODEL, id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  },
  {
    name: "provider excluded",
    role: "lane",
    prompt: "ulw inspect the fixture",
    model: { ...SOL_MODEL, provider: "anthropic", id: "claude-fable", name: "Claude Fable" },
    excluded: true,
  },
  { name: "model excluded", role: "lane", prompt: "ulw inspect the fixture", excludeModel: true, excluded: true },
];
let checked = 0;
for (const [mode, entries] of [
  ["embedded", [dori]],
  ["Dori first", [dori, ulw]],
  ["ULW first", [ulw, dori]],
] as const) {
  for (const scenario of scenarios) {
    const parent = { kind: "main", id: `NativeParent${checked}`, name: "Main", depth: 0 } as const;
    const child = { kind: "sub", id: `NativeChild${checked}`, name: "Child", depth: 1, parentId: parent.id } as const;
    let parentRole: unknown;
    const label = `${mode}: ${scenario.name}`;
    const embedded = mode === "embedded";
    writeFileSync(
      process.env["DORI_CONFIG"]!,
      JSON.stringify({ stateDir: join(cwd, "state"), ompUlwPath: embedded ? ulw : "" }),
    );
    writeFileSync(
      process.env["OMP_ULW_SCOPE_FILE"],
      JSON.stringify({
        excludeProviders: ["anthropic"],
        excludeModelPatterns: scenario.excludeModel ? [SOL_MODEL.id] : [],
      }),
    );
    const downstream = [
      "F67_PROJECT_RULE: preserve this block exactly",
      scenario.child
        ? "F67_CHILD_ASSIGNMENT: read only; return evidence to parent"
        : "F67_PARENT_CONTEXT: retained task context",
    ];
    let inheritedPolicy: string | undefined;
    const model = scenario.model ?? SOL_MODEL;
    if (scenario.child) {
      // A unique, explicitly initialized native parent owns this unflagged child.
      const owner = await nativeComposition(entries, ["F67_PARENT_ROLE_SETUP"], {
        cwd,
        role: "lane",
        model,
        agent: parent,
        prompt: "ulw inspect the fixture",
      });
      parentRole = owner.entries
        .flatMap((entry) => (entry.type === "custom" && entry.customType === "omp-dori:role" ? [entry.data] : []))
        .at(-1);
      inheritedPolicy = owner.first?.find((block) => block.startsWith("<omp-ulw-policy>"));
      assert(inheritedPolicy, `${label} parent did not produce a policy to inherit`);
    }
    const seed = inheritedPolicy ? [...downstream, inheritedPolicy] : downstream;
    const before = [...seed];
    const result = await nativeComposition(entries, seed, {
      nativePrompt: true,
      ...(scenario.customPrompt === undefined ? {} : { customPrompt: scenario.customPrompt }),
      cwd,
      compact: true,
      ...(scenario.role === undefined || scenario.child ? {} : { role: scenario.role }),
      model,
      agent: scenario.child ? child : parent,
      prompt: scenario.prompt,
      activeTools: scenario.child ? ["read", "monitor"] : ["read", "bash"],
      tools: {
        read: "F67_READ_CAPABILITY",
        bash: "F67_BASH_CAPABILITY",
        task: "F67_EXCLUDED_CAPABILITY",
        monitor: "F67_MONITOR_CAPABILITY",
      },
    });
    if (scenario.child) assert.equal(parentRole, "lane", `${label} did not inherit a lane parent`);
    assert.deepEqual(
      result.entries.flatMap((entry) =>
        entry.type === "custom" && entry.customType === "omp-dori:role" ? [entry.data] : [],
      ),
      scenario.child || scenario.role === undefined ? [] : [scenario.role],
      `${label} changed the recorded role`,
    );
    const first = result.first ?? result.base;
    const second = result.second ?? result.base;
    const compacted = result.postCompaction?.systemPrompt ?? result.base;
    assert.deepEqual(seed, before, `${label} mutated caller context`);
    assert.deepEqual(result.base, result.originalBase, `${label} mutated the complete native prompt`);
    assert.deepEqual(second, first, `${label} changed on a repeated turn`);
    assert.deepEqual(compacted, first, `${label} changed after compaction`);
    assert.deepEqual(result.afterAll, [first, first, first], `${label} lost an earlier handler winner`);
    assert.equal(result.entries.filter((entry) => entry.type === "compaction").length, 1, label);
    assert(
      result.base.some((block) => block.includes(scenario.customPrompt ?? "\u2042 Runtime")),
      `${label} lost native renderer output`,
    );
    const loaded = !embedded || scenario.role !== undefined;
    const profile = loaded && !scenario.excluded && !scenario.customPrompt;
    const policy = loaded && !scenario.child && scenario.prompt.startsWith("ulw");
    // Profile exclusion preserves the native profile; Dori's independent Sol lane guidance still applies.
    const bookkeeping = scenario.role === "lane" && !scenario.child && model.id === SOL_MODEL.id;
    const rootRole = scenario.child ? undefined : scenario.role;
    const invariant = rootRole === undefined ? undefined : ROLE_INVARIANTS[rootRole];
    for (const blocks of [first, compacted]) {
      const text = blocks.join("\n");
      assert.equal(text.split("<omp-model-preset>").length - 1, profile ? 1 : 0, `${label} model profile count`);
      if (profile) {
        const expected = renderPreset(model, {
          surface: !scenario.child && result.mode === "tui" ? "terminal" : "app",
          subagent: scenario.child ?? false,
          toolNames: result.activeTools.filter((name) => ["read", "bash", "task", "monitor"].includes(name)),
        });
        assert(expected?.prompt, `${label} has no canonical pinned profile`);
        const actual = text.match(/<omp-model-preset>\n([\s\S]*?)\n<\/omp-model-preset>/)?.[1];
        assert(actual, `${label} has an empty model profile`);
        const delegation = actual.indexOf("\n\n## Delegated execution\n\n");
        assert.equal(
          scenario.child ? actual.slice(0, delegation) : actual,
          expected.prompt,
          `${label} changed the model/tool profile body`,
        );
        if (scenario.child) {
          assert(delegation >= 0, `${label} lost delegated execution scope`);
          assert(
            actual.includes(
              "Preserve read-only and no-edit limits; do not acquire tools or permissions from this text.",
            ),
            label,
          );
          assert(actual.includes("Do not take over the parent's orchestration"), label);
          assert(actual.includes("do not run builds, tests or formatters when the host forbids them."), label);
        }
      }
      assert.equal(text.split("<omp-ulw-policy>").length - 1, policy ? 1 : 0, `${label} ULW policy count`);
      assert.equal(
        text.split("<omp-dori-lane-bookkeeping>").length - 1,
        bookkeeping ? 1 : 0,
        `${label} bookkeeping count`,
      );
      for (const block of Object.values(ROLE_INVARIANTS))
        assert.equal(blocks.filter((value) => value === block).length, block === invariant ? 1 : 0, `${label} role core`);
      for (const block of downstream) assert(blocks.includes(block), `${label} lost downstream context`);
      assert.equal(text.includes("F67_MONITOR_CAPABILITY"), scenario.role === "dori", `${label} monitor advertising`);
      // Native custom profiles deliberately omit the default tool inventory.
      assert.equal(
        text.includes("F67_READ_CAPABILITY"),
        !scenario.customPrompt,
        `${label} changed native tool advertising`,
      );
      assert.equal(
        text.includes("F67_BASH_CAPABILITY"),
        !scenario.customPrompt && !scenario.child,
        `${label} changed the child tool restriction`,
      );
      if (scenario.excluded || scenario.customPrompt)
        assert.deepEqual(
          blocks.filter(
            (block) =>
              block !== invariant &&
              !block.startsWith("<omp-ulw-policy>") &&
              !block.startsWith("<omp-dori-lane-bookkeeping>"),
          ),
          result.base,
          `${label} changed the excluded native profile`,
        );
      assert(!text.includes("F67_EXCLUDED_CAPABILITY"), `${label} advertised an inactive tool`);
    }
    if (scenario.child) {
      assert(inheritedPolicy && result.base.includes(inheritedPolicy), `${label} did not receive the parent policy`);
      assert.deepEqual(result.activeTools, ["read"], `${label} widened the native child tool set`);
      if (embedded) {
        const orphanBase = result.base.filter((block) => block !== inheritedPolicy);
        const orphan = await nativeComposition(entries, orphanBase, {
          cwd,
          model,
          agent: { ...child, parentId: `MissingParent${checked}` },
          prompt: scenario.prompt,
          activeTools: ["read"],
        });
        assert.deepEqual(orphan.first ?? orphan.base, orphanBase, `${label} inherited an unrelated parent role`);
      }
    }
    const initial = JSON.stringify(result.firstResult ?? null);
    const after = JSON.stringify(result.postCompaction ?? null);
    assert.equal(
      initial.includes("<omp-ulw-plan-pointer>"),
      scenario.name === "lane specialized",
      `${label} initial workflow selection`,
    );
    assert.equal(after.includes("<omp-ultrawork-reminder>"), policy, `${label} compaction activation reminder`);
    assert(!after.includes("<omp-ulw-plan-pointer>"), `${label} reselected a workflow on an ordinary follow-up`);
    checked++;
  }
}
const manifest = await Bun.file(join(process.env["DORI_TEST_OMP_ROOT"], "package.json")).json();
console.log(JSON.stringify({ nativeVersion: manifest.version, cases: checked, networkAttempts }));

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../src/update/source.ts";
import { git, setup } from "./install-setup.ts";

// POSIX-only: the source installer and its fixture use Bash and POSIX paths and permissions.
const posix = test.skipIf(process.platform === "win32");

const records = (text: string, prefix: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${prefix} `))
    .map((line) => JSON.parse(line.slice(prefix.length + 1)));

function editDuringInstall(s: ReturnType<typeof setup>) {
  const path = join(s.root, "bin/bun");
  const body = readFileSync(path, "utf8");
  writeFileSync(
    path,
    body.replace(
      "#!/bin/sh\n",
      [
        "#!/bin/sh",
        'if [ "$1" = install ] && [ ! -e "$INSTALL_TEST_EDIT_MARKER" ]; then',
        '  printf "%s" "$INSTALL_TEST_CONFIG_BYTES" > "$INSTALL_TEST_CONFIG_PATH"',
        '  printf done > "$INSTALL_TEST_EDIT_MARKER"',
        "fi",
        "",
      ].join("\n"),
    ),
  );
}

posix("source configuration preview changes no checkout, dependency, reference or configuration", () => {
  const s = setup();
  const head = git(s.src, "rev-parse", "HEAD");
  s.upstreamCommit("v2\n");
  const result = s.install({ DORI_INSTALL_MODE: "primary" }, ["--preview"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("SETUP_PREVIEW_ONLY");
  const plans = records(result.err, "SETUP_PREVIEW");
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ path: join(s.home, ".dori/config.json"), action: "create" });
  expect(git(s.src, "rev-parse", "HEAD")).toBe(head);
  expect(existsSync(join(s.root, "bun.log"))).toBe(false);
  for (const name of [".dori", ".bun", "skills", "extensions", "global-bin"])
    expect(existsSync(join(s.home, name))).toBe(false);
  const installed = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1" });
  expect(installed.code).toBe(0);
  expect(plans[0]!["afterSha256"]).toBe(digest(readFileSync(join(s.home, ".dori/config.json"))));
  expect(records(installed.out, "SETUP_READBACK")[0]).toMatchObject({ saved: true, effective: "selected" });
});

posix("source preview never probes the owner-selected OMP executable", () => {
  const s = setup();
  const executable = join(s.root, "owner-omp");
  const calls = join(s.root, "owner-omp.calls");
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_TEST_OMP_CALLS"\nprintf "18.20.0\\n"\n', {
    mode: 0o700,
  });
  const result = s.install({ DORI_INSTALL_MODE: "primary", DORI_OMP: executable, INSTALL_TEST_OMP_CALLS: calls }, [
    "--preview",
  ]);
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain("SETUP_PREVIEW_ONLY");
  expect(existsSync(calls)).toBe(false);
  expect(existsSync(join(s.root, "bun.log"))).toBe(false);
  expect(existsSync(join(s.home, ".dori"))).toBe(false);
});

posix("source preview neither discloses nor validates an owner ULW checkout value", () => {
  const s = setup();
  const base = join(s.home, ".omp-dori");
  mkdirSync(base, { mode: 0o700 });
  const path = join(base, "config.json");
  const sentinel = "private-owner-ulw-checkout";
  const original = JSON.stringify({ ompUlwPath: join(s.home, sentinel, "index.ts") });
  writeFileSync(path, original, { mode: 0o600 });

  const result = s.install({ DORI_INSTALL_MODE: "side", OMP_ULW_SRC: "" }, ["--preview"]);
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain("SETUP_PREVIEW_ONLY");
  expect(result.out + result.err).not.toContain(sentinel);
  expect(records(result.err, "SETUP_PREVIEW")).toContainEqual(
    expect.objectContaining({ path, action: "update", beforeSha256: digest(original) }),
  );
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(existsSync(join(base, "omp.yml"))).toBe(false);
  expect(existsSync(join(s.root, "bun.log"))).toBe(false);
});

posix("source setup preserves custom argv, model, hooks and unknown keys without printing their values", () => {
  const s = setup();
  const base = join(s.home, ".dori");
  mkdirSync(base, { mode: 0o700 });
  const config = {
    agentCommand: ["owner-command", "--api-key", "owner-secret"],
    defaultModel: "owner/model",
    hooks: { transcribe: ["owner-transcribe", "owner-secret"] },
    unknown: { keep: [1, { nested: true }] },
    ompUlwPath: "/previous/managed/ulw.ts",
  };
  const path = join(base, "config.json");
  writeFileSync(path, JSON.stringify(config));
  chmodSync(path, 0o640);
  const result = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1" });
  expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...config, ompUlwPath: "" });
  expect(statSync(path).mode & 0o777).toBe(0o640);
  expect(result.out + result.err).not.toContain("owner-secret");
  expect(result.out + result.err).not.toContain("owner/model");
  expect(result.out).toContain("Installation does not start a messenger or watcher");
});

posix("side YAML refreshes only managed keys without changing owner model, memory or unknown settings", () => {
  const s = setup();
  const base = join(s.home, ".omp-dori");
  mkdirSync(base, { mode: 0o700 });
  const yaml = {
    skills: { ignoredSkills: ["owner-hidden"], customDirectories: ["/owner/skills"], unknown: "keep" },
    update: { auto: true, channel: "owner" },
    models: { selected: "owner/model" },
    memory: { enabled: false },
    unknown: { secret: "yaml-owner-secret" },
  };
  const overlay = join(base, "omp.yml");
  const original = Bun.YAML.stringify(yaml);
  writeFileSync(overlay, original, { mode: 0o600 });
  mkdirSync(join(s.home, ".omp/agent"), { recursive: true });
  const global = join(s.home, ".omp/agent/config.yml");
  writeFileSync(global, "memory: false\nmodel: untouched\n");
  const preview = s.install({ DORI_INSTALL_MODE: "side" }, ["--preview"]);
  expect(preview.code).toBe(0);
  expect(readFileSync(overlay, "utf8")).toBe(original);
  const installed = s.install({ DORI_INSTALL_MODE: "side", DORI_NO_PULL: "1" });
  expect(installed.code).toBe(0);
  expect(Bun.YAML.parse(readFileSync(join(base, "omp.yml"), "utf8"))).toEqual({
    ...yaml,
    skills: {
      ...yaml.skills,
      ignoredSkills: ["dori-mode"],
      customDirectories: [join(base, "skills")],
    },
    update: { ...yaml.update, auto: false },
  });
  expect(records(preview.err, "SETUP_PREVIEW").find((plan) => plan["path"] === overlay)).toMatchObject({
    beforeSha256: digest(original),
    afterSha256: digest(readFileSync(overlay)),
  });
  expect(readFileSync(global, "utf8")).toBe("memory: false\nmodel: untouched\n");
  expect(installed.out + installed.err).not.toContain("yaml-owner-secret");
  expect(records(installed.out, "SETUP_READBACK")).toHaveLength(2);
  expect(records(installed.out, "SETUP_READBACK")[1]).toMatchObject({ nativeSession: "not-started" });
});

posix.each(["config.json", "omp.yml"])(
  "source setup refuses a concurrent %s edit during package preparation",
  (name) => {
    const s = setup();
    const base = join(s.home, ".omp-dori");
    mkdirSync(base, { mode: 0o700 });
    writeFileSync(join(base, "config.json"), '{"owner":"original"}\n', { mode: 0o600 });
    writeFileSync(join(base, "omp.yml"), "owner: original\n", { mode: 0o600 });
    editDuringInstall(s);
    const text = name === "config.json" ? '{"owner":"concurrent"}\n' : "owner: concurrent\n";
    const result = s.install({
      DORI_INSTALL_MODE: "side",
      DORI_NO_PULL: "1",
      INSTALL_TEST_EDIT_MARKER: join(s.root, "edited"),
      INSTALL_TEST_CONFIG_PATH: join(base, name),
      INSTALL_TEST_CONFIG_BYTES: text,
    });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Configuration changed during setup");
    expect(readFileSync(join(base, name), "utf8")).toBe(text);
    expect(result.out).not.toContain("SETUP_READBACK");
    expect(result.out).not.toContain("Installed next");
  },
);

posix("readback distinguishes a saved file from effective environment overrides and another selected config", () => {
  const s = setup();
  const base = join(s.home, ".dori");
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, "config.json"), JSON.stringify({ stateDir: join(base, "owned"), leadPane: "owner-pane" }), {
    mode: 0o600,
  });
  const result = s.install({
    DORI_INSTALL_MODE: "primary",
    DORI_NO_PULL: "1",
    DORI_STATE_DIR: join(base, "override"),
    DORI_LEAD_PANE: "override-pane",
  });
  expect(result.code).toBe(0);
  expect(records(result.out, "SETUP_READBACK")[0]).toMatchObject({
    saved: true,
    effective: "shadowed",
    overridden: ["stateDir", "leadPane"],
  });
  const alternate = join(s.home, "alternate.json");
  writeFileSync(alternate, "{}\n", { mode: 0o600 });
  const second = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1", DORI_CONFIG: alternate });
  expect(second.code).toBe(0);
  expect(records(second.out, "SETUP_READBACK")[0]).toMatchObject({ effective: "shadowed", selectedConfig: alternate });
});

posix("readback exposes environment overrides of omitted reader defaults", () => {
  const s = setup();
  const base = join(s.home, ".dori");
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, "config.json"), "{}\n", { mode: 0o600 });
  const result = s.install({
    DORI_INSTALL_MODE: "primary",
    DORI_NO_PULL: "1",
    DORI_STATE_DIR: join(base, "override"),
    DORI_LEAD_PANE: "override-pane",
  });
  expect(result.code).toBe(0);
  expect(records(result.out, "SETUP_READBACK")[0]).toMatchObject({
    saved: true,
    effective: "shadowed",
    overridden: ["stateDir", "leadPane"],
  });
});

posix("effective-reader validation errors do not print private configuration values", () => {
  const s = setup();
  const base = join(s.home, ".dori");
  mkdirSync(base, { mode: 0o700 });
  writeFileSync(join(base, "config.json"), '{"runtime":{"secret":"do-not-print-this"}}\n', { mode: 0o600 });
  const result = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1" });
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Invalid effective Dori configuration");
  expect(result.out + result.err).not.toContain("do-not-print-this");
  expect(result.out).not.toContain("Installed.");
});
posix("a failed override read still reports saved bytes without exposing the override", () => {
  const s = setup();
  const invalid = "private-invalid-argv";
  const result = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1", DORI_AGENT_ARGV: invalid });
  expect(result.code).not.toBe(0);
  expect(records(result.out, "SETUP_READBACK")[0]).toMatchObject({
    saved: true,
    effective: "unavailable",
    overridden: null,
    reason: "configuration-reader-unavailable",
  });
  expect(result.out + result.err).not.toContain(invalid);
});

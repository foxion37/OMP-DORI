import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, script, setup } from "./install-setup.ts";

const OTHER_CONFIG = '{"owner":"another Dori"}\n';

// Another Dori's installation: its home, its dori-mode skill link and its global dori bin.
function withOtherDori(home: string) {
  mkdirSync(join(home, ".dori"));
  writeFileSync(join(home, ".dori/config.json"), OTHER_CONFIG);
  mkdirSync(join(home, "skills"));
  symlinkSync("/elsewhere/dori-mode", join(home, "skills/dori-mode"));
  mkdirSync(join(home, "global-bin"));
  symlinkSync("/elsewhere/cli.ts", join(home, "global-bin/dori"));
}

const expectOtherDoriUntouched = (home: string) => {
  expect(readFileSync(join(home, ".dori/config.json"), "utf8")).toBe(OTHER_CONFIG);
  expect(readdirSync(join(home, ".dori"))).toEqual(["config.json"]);
  expect(readlinkSync(join(home, "skills/dori-mode"))).toBe("/elsewhere/dori-mode");
  expect(readlinkSync(join(home, "global-bin/dori"))).toBe("/elsewhere/cli.ts");
};

test("another Dori in ~/.dori stops an install with no terminal and no mode, and nothing changes", () => {
  // Given another Dori's ~/.dori.
  const { root, home, install } = setup();
  withOtherDori(home);
  // When scripts/install-source.sh runs without a terminal or DORI_INSTALL_MODE.
  const r = install();
  // Then it stops, names both modes, and leaves every file of the other Dori and every OMP location as it was.
  expect(r.code).toBe(1);
  expect(r.err).toContain("DORI_INSTALL_MODE=side");
  expect(r.err).toContain("DORI_INSTALL_MODE=primary");
  expectOtherDoriUntouched(home);
  expect(existsSync(join(home, "extensions/omp-dori"))).toBe(false);
  expect(existsSync(join(home, ".omp-dori"))).toBe(false);
  expect(existsSync(join(root, "bun.log"))).toBe(false);
});

test("a side install lives in ~/.omp-dori and leaves ~/.dori, the dori-mode link and the dori command alone", () => {
  // Given another Dori's ~/.dori.
  const { home, src, ulw, install } = setup();
  withOtherDori(home);
  // When scripts/install-source.sh runs with DORI_INSTALL_MODE=side.
  const r = install({ DORI_INSTALL_MODE: "side" });
  // Then the other Dori is unchanged, no global extension or dori bin was linked, and only omp-dori was added.
  expect(r.code).toBe(0);
  expectOtherDoriUntouched(home);
  const side = join(home, ".omp-dori");
  expect(existsSync(join(home, "extensions/omp-dori"))).toBe(false);
  expect(readlinkSync(join(home, "global-bin/omp-dori"))).toBe(join(side, "bin/omp-dori"));
  expect(readFileSync(join(side, ".omp-dori"), "utf8")).toBe("side\n");
  // And its configuration keeps state and lanes inside the side home.
  const config = JSON.parse(readFileSync(join(side, "config.json"), "utf8"));
  expect(config.stateDir).toBe(join(side, "state"));
  expect(config.agentCommand).toEqual([join(side, "bin/omp"), "--dori-role", "lane", "--model", "{model}", "{prompt}"]);
  // omp-ulw loads as an OMP extension of omp-dori omp, so the omp-dori extension imports no second copy.
  expect(config.ompUlwPath).toBe("");
  expect(existsSync(join(ulw, "index.ts"))).toBe(true);
  // And its skill is a renamed copy whose description differs from dori-mode's, so omp lists both apart.
  const skill = readFileSync(join(side, "skills/omp-dori-mode/SKILL.md"), "utf8");
  expect(skill).toContain("\nname: omp-dori-mode\n");
  const description = skill.match(/^description: (.+)$/m)?.[1];
  const original = readFileSync(join(src, "skills/dori-mode/SKILL.md"), "utf8");
  expect(description).toBeDefined();
  expect(description).not.toBe(original.match(/^description: (.+)$/m)?.[1]);
  expect(readlinkSync(join(side, "skills/omp-dori-mode/references"))).toBe(join(src, "skills/dori-mode/references"));
});

test("a side install from a linked git worktree installs that checkout instead of cloning over it", () => {
  // Given another Dori's ~/.dori and a linked worktree of the omp-dori checkout, whose .git is a file.
  const { root, home, src, cli, install } = setup();
  withOtherDori(home);
  const worktree = join(root, "worktree");
  git(src, "worktree", "add", "-q", "-b", "wt", worktree);
  // When scripts/install-source.sh runs in side mode with DORI_SRC naming the worktree.
  const r = install({ DORI_INSTALL_MODE: "side", DORI_SRC: worktree, DORI_NO_PULL: "1" });
  // Then it installs the worktree as it is, and the side dori wrapper runs the worktree's CLI.
  expect(r.code).toBe(0);
  expectOtherDoriUntouched(home);
  expect(readFileSync(join(home, ".omp-dori/bin/dori"), "utf8")).toContain(join(worktree, cli));
});

test("OMP_DORI_HC_SPACE puts DORI_HC_SPACE into the side env; without it the side env names no space", () => {
  // Given another Dori's ~/.dori.
  const { home, install } = setup();
  withOtherDori(home);
  const env = () => readFileSync(join(home, ".omp-dori/env.sh"), "utf8");
  // When a side install runs without a space, then again with one.
  expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
  expect(env()).not.toContain("DORI_HC_SPACE");
  const r = install({ DORI_INSTALL_MODE: "side", OMP_DORI_HC_SPACE: "sp0a1b" });
  expect(r.code).toBe(0);
  // Then only the second env exports it, the lead command it prints opens in that space, and the other Dori is unchanged.
  expect(env()).toContain("export DORI_HC_SPACE=sp0a1b\n");
  expect(r.out).toContain("--label herdr.space=sp0a1b --");
  expectOtherDoriUntouched(home);
});

test("an omp-dori install from before the marker, with its checkout elsewhere, is updated without asking", () => {
  // Given an unmanaged source home whose earlier source installer linked the external checkout's extension.
  const { home, src, install } = setup();
  mkdirSync(join(home, ".dori"));
  writeFileSync(join(home, ".dori/config.json"), "{}\n");
  mkdirSync(join(home, "extensions"));
  symlinkSync(join(src, "extension"), join(home, "extensions/omp-dori"));
  mkdirSync(join(home, "global-bin"));
  symlinkSync(join(src, "skills/dori-mode/scripts"), join(home, "global-bin/old-scripts"));
  symlinkSync("old-scripts/src/cli.ts", join(home, "global-bin/dori"));
  // When scripts/install-source.sh runs with no mode and no terminal.
  const r = install();
  // Then it installs in place as before: no question, no backup, and the marker now records it.
  expect(r.code).toBe(0);
  expect(existsSync(join(home, ".dori/backups"))).toBe(false);
  expect(readFileSync(join(home, ".dori/.omp-dori"), "utf8")).toBe("primary\n");
  expect(readlinkSync(join(home, "global-bin/dori"))).toBe(join(src, "skills/dori-mode/scripts/src/cli.ts"));
});

test("a later run of a side install stays a side install without asking", () => {
  // Given a side install next to another Dori.
  const { home, install } = setup();
  withOtherDori(home);
  expect(install({ DORI_INSTALL_MODE: "side" }).code).toBe(0);
  // When scripts/install-source.sh runs again with no mode and no terminal.
  const r = install();
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, ".omp-dori/.omp-dori"), "utf8")).toBe("side\n");
  expectOtherDoriUntouched(home);
});

test("primary over another Dori keeps its config and link targets, then takes ~/.dori", () => {
  // Given another Dori's ~/.dori.
  const { home, src, install } = setup();
  withOtherDori(home);
  // When scripts/install-source.sh runs with DORI_INSTALL_MODE=primary.
  expect(install({ DORI_INSTALL_MODE: "primary" }).code).toBe(0);
  // Then a backup holds the previous config and link targets, and the dori-mode link now points at omp-dori.
  const backups = readdirSync(join(home, ".dori/backups"));
  expect(backups).toHaveLength(1);
  const backup = join(home, ".dori/backups", backups[0] ?? "");
  expect(readFileSync(join(backup, "config.json"), "utf8")).toBe(OTHER_CONFIG);
  expect(readFileSync(join(backup, "links.txt"), "utf8")).toContain("-> /elsewhere/dori-mode");
  expect(readFileSync(join(backup, "links.txt"), "utf8")).toContain(
    `${join(home, "global-bin/dori")} -> /elsewhere/cli.ts\n`,
  );
  expect(readlinkSync(join(home, "global-bin/dori"))).toBe(join(src, "skills/dori-mode/scripts/src/cli.ts"));
  expect(readlinkSync(join(home, "skills/dori-mode"))).toBe(join(src, "skills/dori-mode"));
  expect(readFileSync(join(home, ".dori/.omp-dori"), "utf8")).toBe("primary\n");
});

test.each([".bun/bin", "custom-bin"])("primary backs up and replaces a foreign dori symlink in %s", (directory) => {
  const { home, src, install } = setup();
  const bin = join(home, directory);
  const untouchedBin = join(home, directory === ".bun/bin" ? "global-bin" : ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(untouchedBin, { recursive: true });
  symlinkSync("/elsewhere/cli.ts", join(bin, "dori"));
  symlinkSync("/untouched/cli.ts", join(untouchedBin, "dori"));
  const options = { DORI_INSTALL_MODE: "primary", OMP_DORI_BIN_DIR: directory === ".bun/bin" ? "" : bin };

  expect(install(options).code).toBe(0);
  expect(readlinkSync(join(bin, "dori"))).toBe(join(src, "skills/dori-mode/scripts/src/cli.ts"));
  expect(existsSync(join(bin, "dori"))).toBe(true);
  expect(readlinkSync(join(untouchedBin, "dori"))).toBe("/untouched/cli.ts");
  const backups = readdirSync(join(home, ".dori/backups"));
  expect(backups).toHaveLength(1);
  const backup = join(home, ".dori/backups", backups[0] ?? "");
  const links = readFileSync(join(backup, "links.txt"), "utf8");
  expect(links).toContain(`${join(bin, "dori")} -> /elsewhere/cli.ts\n`);

  expect(install(options).code).toBe(0);
  expect(readlinkSync(join(bin, "dori"))).toBe(join(src, "skills/dori-mode/scripts/src/cli.ts"));
  expect(readlinkSync(join(untouchedBin, "dori"))).toBe("/untouched/cli.ts");
  expect(readdirSync(join(home, ".dori/backups"))).toEqual(backups);
  expect(readFileSync(join(backup, "links.txt"), "utf8")).toBe(links);
});

test("primary preserves a regular dori command and names the conflicting destination", () => {
  const { home, install } = setup();
  const command = join(home, "global-bin/dori");
  mkdirSync(join(home, "global-bin"));
  writeFileSync(command, "owner command\n");

  const r = install({ DORI_INSTALL_MODE: "primary" });
  expect(r.code).toBe(1);
  expect(r.err).toContain(command);
  expect(r.err).toContain("OMP_DORI_BIN_DIR");
  expect(readFileSync(command, "utf8")).toBe("owner command\n");
  expect(existsSync(join(home, ".dori/.omp-dori"))).toBe(false);
});

test("primary refuses a ~/.dori/src that is another repository and changes nothing", () => {
  // Given another Dori whose ~/.dori/src checks out a different repository.
  const { root, home, install } = setup();
  withOtherDori(home);
  const other = join(home, ".dori/src");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  git(other, "remote", "add", "origin", "https://github.com/example/dori-superagent.git");
  // When the source installer would use it as the omp-dori checkout.
  const r = install({ DORI_INSTALL_MODE: "primary", DORI_SRC: "" });
  // Then it stops before any backup, link or package install, and points at the side mode.
  expect(r.code).toBe(1);
  expect(r.err).toContain("dori-superagent");
  expect(r.err).toContain("DORI_INSTALL_MODE=side");
  expect(readdirSync(join(home, ".dori")).sort()).toEqual(["config.json", "src"]);
  expect(readlinkSync(join(home, "skills/dori-mode"))).toBe("/elsewhere/dori-mode");
  expect(existsSync(join(root, "bun.log"))).toBe(false);
});

test("in a terminal the owner is asked, and the default answer installs next to the other Dori", async () => {
  // Given another Dori's ~/.dori and the source installer in a terminal with no mode.
  const { home, env } = setup();
  withOtherDori(home);
  let screen = "";
  let answered = false;
  const proc = Bun.spawn([script], {
    env: env(),
    timeout: 60_000,
    terminal: {
      cols: 120,
      rows: 40,
      data(term, chunk) {
        screen += new TextDecoder().decode(chunk);
        // When the question appears, the owner presses Enter.
        if (!answered && screen.includes("Install as 1 or 2")) {
          answered = true;
          term.write("\n");
        }
      },
    },
  });
  // Then the install finishes as a side install and the other Dori is unchanged.
  expect(await proc.exited).toBe(0);
  expect(screen).toContain("belongs to another Dori installation");
  expect(readFileSync(join(home, ".omp-dori/.omp-dori"), "utf8")).toBe("side\n");
  expectOtherDoriUntouched(home);
});

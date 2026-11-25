import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, script, setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and links commands with POSIX symlinks.
const posix = test.skipIf(process.platform === "win32");

const OTHER_CONFIG = '{"owner":"another Cataly"}\n';

// Another Cataly's installation: its home, its cataly-mode skill link and its global cataly bin.
function withOtherCataly(home: string) {
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/config.json"), OTHER_CONFIG);
  mkdirSync(join(home, "skills"));
  symlinkSync("/elsewhere/cataly-mode", join(home, "skills/cataly-mode"));
  mkdirSync(join(home, "global-bin"));
  symlinkSync("/elsewhere/cli.ts", join(home, "global-bin/cataly"));
}

const expectOtherCatalyUntouched = (home: string) => {
  expect(readFileSync(join(home, ".cataly/config.json"), "utf8")).toBe(OTHER_CONFIG);
  expect(readdirSync(join(home, ".cataly"))).toEqual(["config.json"]);
  expect(readlinkSync(join(home, "skills/cataly-mode"))).toBe("/elsewhere/cataly-mode");
  expect(readlinkSync(join(home, "global-bin/cataly"))).toBe("/elsewhere/cli.ts");
};

posix("another Cataly in ~/.cataly stops an install with no terminal and no mode, and nothing changes", () => {
  const { root, home, install } = setup();
  withOtherCataly(home);
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain("CATALY_INSTALL_MODE=side");
  expect(r.err).toContain("CATALY_INSTALL_MODE=primary");
  expectOtherCatalyUntouched(home);
  expect(existsSync(join(home, "extensions/omp-cataly"))).toBe(false);
  expect(existsSync(join(home, ".omp-cataly"))).toBe(false);
  expect(existsSync(join(root, "bun.log"))).toBe(false);
});

posix(
  "a side install lives in ~/.omp-cataly and leaves ~/.cataly, the cataly-mode link and the cataly command alone",
  () => {
    // Given another Cataly's ~/.cataly.
    const { home, src, install } = setup();
    withOtherCataly(home);
    // When scripts/install-source.sh runs with CATALY_INSTALL_MODE=side.
    const r = install({ CATALY_INSTALL_MODE: "side" });
    // Then the other Cataly is unchanged, no global extension or cataly bin was linked, and only omp-cataly was added.
    expect(r.code).toBe(0);
    expectOtherCatalyUntouched(home);
    const side = join(home, ".omp-cataly");
    expect(existsSync(join(home, "extensions/omp-cataly"))).toBe(false);
    expect(readlinkSync(join(home, "global-bin/omp-cataly"))).toBe(join(side, "bin/omp-cataly"));
    expect(readFileSync(join(side, ".omp-cataly"), "utf8")).toBe("side\n");
    // And its configuration keeps state and lanes inside the side home.
    const config = JSON.parse(readFileSync(join(side, "config.json"), "utf8"));
    expect(config.stateDir).toBe(join(side, "state"));
    expect(config.agentCommand).toEqual([
      join(side, "bin/omp"),
      "--cataly-role",
      "lane",
      "--model",
      "{model}",
      "{prompt}",
    ]);
    // And its skill is a renamed copy whose description differs from cataly-mode's, so omp lists both apart.
    const skill = readFileSync(join(side, "skills/omp-cataly-mode/SKILL.md"), "utf8");
    expect(skill).toContain("\nname: omp-cataly-mode\n");
    const description = skill.match(/^description: (.+)$/m)?.[1];
    const original = readFileSync(join(src, "skills/cataly-mode/SKILL.md"), "utf8");
    expect(description).toBeDefined();
    expect(description).not.toBe(original.match(/^description: (.+)$/m)?.[1]);
    expect(readlinkSync(join(side, "skills/omp-cataly-mode/references"))).toBe(
      join(src, "skills/cataly-mode/references"),
    );
    // And omp-cataly omp never self-updates: OMP would overwrite this wrapper, the first omp on the side PATH.
    expect(readFileSync(join(side, "bin/omp"), "utf8")).toContain(`--config ${join(side, "omp.yml")}`);
    expect(readFileSync(join(side, "env.sh"), "utf8")).toContain(`export PATH=${join(side, "bin")}:`);
    expect(Bun.YAML.parse(readFileSync(join(side, "omp.yml"), "utf8"))).toMatchObject({ update: { auto: false } });
  },
);

posix("a side install from a linked git worktree installs that checkout instead of cloning over it", () => {
  const { root, home, src, cli, install } = setup();
  withOtherCataly(home);
  const worktree = join(root, "worktree");
  git(src, "worktree", "add", "-q", "-b", "wt", worktree);
  const r = install({ CATALY_INSTALL_MODE: "side", CATALY_SRC: worktree, CATALY_NO_PULL: "1" });
  expect(r.code).toBe(0);
  expectOtherCatalyUntouched(home);
  expect(readFileSync(join(home, ".omp-cataly/bin/cataly"), "utf8")).toContain(join(worktree, cli));
});

posix("an omp-cataly install from before the marker, with its checkout elsewhere, is updated without asking", () => {
  // Given an unmanaged source home whose earlier source installer linked the external checkout's extension.
  const { home, src, install } = setup();
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  mkdirSync(join(home, "extensions"));
  symlinkSync(join(src, "extension"), join(home, "extensions/omp-cataly"));
  mkdirSync(join(home, "global-bin"));
  symlinkSync(join(src, "skills/cataly-mode/scripts"), join(home, "global-bin/old-scripts"));
  symlinkSync("old-scripts/src/cli.ts", join(home, "global-bin/cataly"));
  // When scripts/install-source.sh runs with no mode and no terminal.
  const r = install();
  // Then it installs in place as before: no question, no backup, and the marker now records it.
  expect(r.code).toBe(0);
  expect(existsSync(join(home, ".cataly/backups"))).toBe(false);
  expect(readFileSync(join(home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
  expect(readlinkSync(join(home, "global-bin/cataly"))).toBe(join(src, "skills/cataly-mode/scripts/src/cli.ts"));
});

posix("a later run of a side install stays a side install without asking", () => {
  // Given a side install next to another Cataly.
  const { home, install } = setup();
  withOtherCataly(home);
  expect(install({ CATALY_INSTALL_MODE: "side" }).code).toBe(0);
  // When scripts/install-source.sh runs again with no mode and no terminal.
  const r = install();
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, ".omp-cataly/.omp-cataly"), "utf8")).toBe("side\n");
  expectOtherCatalyUntouched(home);
});

posix("primary over another Cataly keeps its config and link targets, then takes ~/.cataly", () => {
  // Given another Cataly's ~/.cataly.
  const { home, src, install } = setup();
  withOtherCataly(home);
  // When scripts/install-source.sh runs with CATALY_INSTALL_MODE=primary.
  expect(install({ CATALY_INSTALL_MODE: "primary" }).code).toBe(0);
  // Then a backup holds the previous config and link targets, and the cataly-mode link now points at omp-cataly.
  const backups = readdirSync(join(home, ".cataly/backups"));
  expect(backups).toHaveLength(1);
  const backup = join(home, ".cataly/backups", backups[0] ?? "");
  expect(readFileSync(join(backup, "config.json"), "utf8")).toBe(OTHER_CONFIG);
  expect(readFileSync(join(backup, "links.txt"), "utf8")).toContain("-> /elsewhere/cataly-mode");
  expect(readFileSync(join(backup, "links.txt"), "utf8")).toContain(
    `${join(home, "global-bin/cataly")} -> /elsewhere/cli.ts\n`,
  );
  expect(readlinkSync(join(home, "global-bin/cataly"))).toBe(join(src, "skills/cataly-mode/scripts/src/cli.ts"));
  expect(readlinkSync(join(home, "skills/cataly-mode"))).toBe(join(src, "skills/cataly-mode"));
  expect(readFileSync(join(home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
});

posix.each([".bun/bin", "custom-bin"])("primary backs up and replaces a foreign cataly symlink in %s", (directory) => {
  const { home, src, install } = setup();
  const bin = join(home, directory);
  const untouchedBin = join(home, directory === ".bun/bin" ? "global-bin" : ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(untouchedBin, { recursive: true });
  symlinkSync("/elsewhere/cli.ts", join(bin, "cataly"));
  symlinkSync("/untouched/cli.ts", join(untouchedBin, "cataly"));
  const options = { CATALY_INSTALL_MODE: "primary", OMP_CATALY_BIN_DIR: directory === ".bun/bin" ? "" : bin };

  expect(install(options).code).toBe(0);
  expect(readlinkSync(join(bin, "cataly"))).toBe(join(src, "skills/cataly-mode/scripts/src/cli.ts"));
  expect(existsSync(join(bin, "cataly"))).toBe(true);
  expect(readlinkSync(join(untouchedBin, "cataly"))).toBe("/untouched/cli.ts");
  const backups = readdirSync(join(home, ".cataly/backups"));
  expect(backups).toHaveLength(1);
  const backup = join(home, ".cataly/backups", backups[0] ?? "");
  const links = readFileSync(join(backup, "links.txt"), "utf8");
  expect(links).toContain(`${join(bin, "cataly")} -> /elsewhere/cli.ts\n`);

  expect(install(options).code).toBe(0);
  expect(readlinkSync(join(bin, "cataly"))).toBe(join(src, "skills/cataly-mode/scripts/src/cli.ts"));
  expect(readlinkSync(join(untouchedBin, "cataly"))).toBe("/untouched/cli.ts");
  expect(readdirSync(join(home, ".cataly/backups"))).toEqual(backups);
  expect(readFileSync(join(backup, "links.txt"), "utf8")).toBe(links);
});

posix("primary preserves a regular cataly command and names the conflicting destination", () => {
  const { home, install } = setup();
  const command = join(home, "global-bin/cataly");
  mkdirSync(join(home, "global-bin"));
  writeFileSync(command, "owner command\n");

  const r = install({ CATALY_INSTALL_MODE: "primary" });
  expect(r.code).toBe(1);
  expect(r.err).toContain(command);
  expect(r.err).toContain("OMP_CATALY_BIN_DIR");
  expect(readFileSync(command, "utf8")).toBe("owner command\n");
  expect(existsSync(join(home, ".cataly/.omp-cataly"))).toBe(false);
});

posix("primary refuses a ~/.cataly/src that is another repository and changes nothing", () => {
  const { root, home, install } = setup();
  withOtherCataly(home);
  const other = join(home, ".cataly/src");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  git(other, "remote", "add", "origin", "https://github.com/example/cataly-superagent.git");
  const r = install({ CATALY_INSTALL_MODE: "primary", CATALY_SRC: "" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("cataly-superagent");
  expect(r.err).toContain("CATALY_INSTALL_MODE=side");
  expect(readdirSync(join(home, ".cataly")).sort()).toEqual(["config.json", "src"]);
  expect(readlinkSync(join(home, "skills/cataly-mode"))).toBe("/elsewhere/cataly-mode");
  expect(existsSync(join(root, "bun.log"))).toBe(false);
});

posix("in a terminal the owner is asked, and the default answer installs next to the other Cataly", async () => {
  // Given another Cataly's ~/.cataly and the source installer in a terminal with no mode.
  const { home, env } = setup();
  withOtherCataly(home);
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
  // Then the install finishes as a side install and the other Cataly is unchanged.
  expect(await proc.exited).toBe(0);
  expect(screen).toContain("belongs to another Cataly installation");
  expect(readFileSync(join(home, ".omp-cataly/.omp-cataly"), "utf8")).toBe("side\n");
  expectOtherCatalyUntouched(home);
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, script, setup } from "./install-setup.ts";

// Re-runs over installs made before the marker: none of these may ask, back up or stop.

test("an omp-dori checkout in ~/.dori/src is known by its files, whatever its remote is called", () => {
  // Given the documented layout, cloned from a remote whose name is not omp-dori.
  const { root, home, install } = setup();
  mkdirSync(join(home, ".dori"));
  git(root, "clone", "-q", join(root, "upstream"), join(home, ".dori/src"));
  writeFileSync(join(home, ".dori/config.json"), "{}\n");
  // When scripts/install-source.sh runs with no mode, no terminal and no DORI_SRC.
  const r = install({ DORI_SRC: "" });
  // Then it updates in place: no question, no backup, and the marker records a primary install.
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("another Dori");
  expect(existsSync(join(home, ".dori/backups"))).toBe(false);
  expect(readFileSync(join(home, ".dori/.omp-dori"), "utf8")).toBe("primary\n");
});

test("a ~/.dori that only holds omp-ulw or state is not another Dori", () => {
  // Given a ~/.dori with an earlier omp-ulw checkout and a state directory, but no config and no src.
  const { home, install } = setup();
  mkdirSync(join(home, ".dori/omp-ulw"), { recursive: true });
  mkdirSync(join(home, ".dori/state"));
  // When scripts/install-source.sh runs with no mode and no terminal.
  const r = install();
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, ".dori/.omp-dori"), "utf8")).toBe("primary\n");
  expect(existsSync(join(home, ".omp-dori"))).toBe(false);
});

test("a failed pull over another Dori leaves no backup behind", () => {
  // Given another Dori's ~/.dori and a checkout whose upstream cannot be reached.
  const { root, home, src, install } = setup();
  mkdirSync(join(home, ".dori"));
  writeFileSync(join(home, ".dori/config.json"), "{}\n");
  git(src, "remote", "set-url", "origin", join(root, "missing.git"));
  // When scripts/install-source.sh runs as primary; then it stops at the pull with no backups directory.
  const r = install({ DORI_INSTALL_MODE: "primary" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing.git");
  expect(existsSync(join(home, ".dori/backups"))).toBe(false);
});

test("closing the terminal question stops with a reason and changes nothing", async () => {
  // Given another Dori's ~/.dori and the source installer in a terminal with no mode.
  const { home, env } = setup();
  mkdirSync(join(home, ".dori"));
  writeFileSync(join(home, ".dori/config.json"), "{}\n");
  mkdirSync(join(home, "skills"));
  symlinkSync("/elsewhere/dori-mode", join(home, "skills/dori-mode"));
  let screen = "";
  let closed = false;
  const proc = Bun.spawn([script], {
    env: env(),
    timeout: 60_000,
    terminal: {
      cols: 120,
      rows: 40,
      data(term, chunk) {
        screen += new TextDecoder().decode(chunk);
        // When the question appears, the owner sends end-of-file instead of an answer.
        if (!closed && screen.includes("Install as 1 or 2")) {
          closed = true;
          term.write("\x04");
        }
      },
    },
  });
  // Then the install says so and leaves the other Dori, its skill link and the side home untouched.
  expect(await proc.exited).toBe(1);
  expect(screen).toContain("no answer; nothing was changed");
  expect(readFileSync(join(home, ".dori/config.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(home, ".dori/.omp-dori"))).toBe(false);
  expect(existsSync(join(home, ".omp-dori"))).toBe(false);
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, script, setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

// Re-runs over installs made before the marker: none of these may ask, back up or stop.

posix("an omp-cataly checkout in ~/.cataly/src is known by its files, whatever its remote is called", () => {
  // Given the documented layout, cloned from a remote whose name is not omp-cataly.
  const { root, home, install } = setup();
  mkdirSync(join(home, ".cataly"));
  git(root, "clone", "-q", join(root, "upstream"), join(home, ".cataly/src"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  // When scripts/install-source.sh runs with no mode, no terminal and no CATALY_SRC.
  const r = install({ CATALY_SRC: "" });
  // Then it updates in place: no question, no backup, and the marker records a primary install.
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("another Cataly");
  expect(existsSync(join(home, ".cataly/backups"))).toBe(false);
  expect(readFileSync(join(home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
});

posix("a ~/.cataly that only holds state is not another Cataly", () => {
  // Given a ~/.cataly with a state directory, but no config and no src.
  const { home, install } = setup();
  mkdirSync(join(home, ".cataly/state"), { recursive: true });
  // When scripts/install-source.sh runs with no mode and no terminal.
  const r = install();
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
  expect(existsSync(join(home, ".omp-cataly"))).toBe(false);
});

posix("a failed pull over another Cataly leaves no backup behind", () => {
  // Given another Cataly's ~/.cataly and a checkout whose upstream cannot be reached.
  const { root, home, src, install } = setup();
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  git(src, "remote", "set-url", "origin", join(root, "missing.git"));
  // When scripts/install-source.sh runs as primary; then it stops at the pull with no backups directory.
  const r = install({ CATALY_INSTALL_MODE: "primary" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing.git");
  expect(existsSync(join(home, ".cataly/backups"))).toBe(false);
});

posix("closing the terminal question stops with a reason and changes nothing", async () => {
  // Given another Cataly's ~/.cataly and the source installer in a terminal with no mode.
  const { home, env } = setup();
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  mkdirSync(join(home, "skills"));
  symlinkSync("/elsewhere/cataly-mode", join(home, "skills/cataly-mode"));
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
  // Then the install says so and leaves the other Cataly, its skill link and the side home untouched.
  expect(await proc.exited).toBe(1);
  expect(screen).toContain("no answer; nothing was changed");
  expect(readFileSync(join(home, ".cataly/config.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(home, ".cataly/.omp-cataly"))).toBe(false);
  expect(existsSync(join(home, ".omp-cataly"))).toBe(false);
});

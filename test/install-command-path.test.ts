import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { script, setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs linked through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

// Version/argv stubs only; setup records package installs without installing dependencies.
for (const mode of ["primary", "side"]) {
  posix.each(["absolute", "./tools/omp", "omp", "./tools/custom native 'quote'; literal"])(
    `${mode} resolves override %s before an independent-cwd launch`,
    (command) => {
      const s = setup();
      const name = command === "omp" || command === "absolute" ? "omp" : command.slice("./tools/".length);
      const native = join(s.root, "tools", name);
      mkdirSync(join(s.root, "tools"));
      writeFileSync(
        native,
        '#!/bin/sh\nif [ "$1" = --version ]; then echo 19.0.1; else printf \'%s\\0\' "$0" "$@"; fi\n',
        { mode: 0o755 },
      );
      const nativeBytes = readFileSync(native);
      const env = s.env({
        CATALY_INSTALL_MODE: mode,
        CATALY_NO_PULL: "1",
        CATALY_OMP: command === "absolute" ? native : command,
      });
      if (command === "omp") env.PATH = `tools:${join(s.root, "bin")}:${process.env["PATH"]}`;
      const installed = Bun.spawnSync([script], { cwd: s.root, env });
      expect(installed.exitCode).toBe(0);
      expect(readFileSync(native)).toEqual(nativeBytes);
      const ordinary = join(s.root, "ordinary");
      mkdirSync(join(ordinary, "tools"), { recursive: true });
      writeFileSync(join(ordinary, "tools", name), "#!/bin/sh\nexit 73\n", { mode: 0o755 });
      const base = join(s.home, mode === "side" ? ".omp-cataly" : ".cataly");
      const prompt = "literal ; $(touch relative-suffix-ran)";
      const child = Bun.spawnSync([join(base, "bin/omp"), "probe", prompt], { cwd: ordinary, env });
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe("");
      const argv = child.stdout.toString().split("\0").slice(0, -1);
      expect(isAbsolute(argv[0]!)).toBe(true);
      expect(resolve(argv[0]!)).toBe(native);
      expect(argv.slice(1)).toEqual([
        ...(mode === "side"
          ? ["--no-extensions", "-e", join(s.src, "extension"), "--config", join(base, "omp.yml")]
          : []),
        "probe",
        prompt,
      ]);
      expect(existsSync(join(ordinary, "relative-suffix-ran"))).toBe(false);
      expect(readFileSync(native)).toEqual(nativeBytes);
    },
  );
}

posix("a missing explicit override stops before installation instead of selecting PATH omp", () => {
  const s = setup();
  const installed = Bun.spawnSync([script], {
    cwd: s.root,
    env: s.env({ CATALY_INSTALL_MODE: "side", CATALY_NO_PULL: "1", CATALY_OMP: "./missing tools/omp" }),
  });
  expect(installed.exitCode).toBe(1);
  expect(installed.stderr.toString()).toContain("CATALY_OMP does not name an executable");
  expect(existsSync(join(s.home, ".omp-cataly"))).toBe(false);
});

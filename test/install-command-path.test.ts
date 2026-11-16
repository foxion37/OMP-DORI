import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { script, setup } from "./install-setup.ts";

// Version/argv stubs only; setup records package installs without installing dependencies.
for (const mode of ["primary", "side"]) {
  test.each(["absolute", "./tools/omp", "omp", "./tools/custom native 'quote'; literal"])(
    `${mode} resolves override %s before an independent-cwd launch`,
    (command) => {
      const s = setup();
      const name = command === "omp" || command === "absolute" ? "omp" : command.slice("./tools/".length);
      const native = join(s.root, "tools", name);
      mkdirSync(join(s.root, "tools"));
      writeFileSync(
        native,
        '#!/bin/sh\nif [ "$1" = --version ]; then echo 18.20.0; else printf \'%s\\0\' "$0" "$@"; fi\n',
        { mode: 0o755 },
      );
      const nativeBytes = readFileSync(native);
      const env = s.env({
        DORI_INSTALL_MODE: mode,
        DORI_NO_PULL: "1",
        DORI_OMP: command === "absolute" ? native : command,
      });
      if (command === "omp") env.PATH = `tools:${join(s.root, "bin")}:${process.env["PATH"]}`;
      const installed = Bun.spawnSync([script], { cwd: s.root, env });
      expect(installed.exitCode).toBe(0);
      expect(readFileSync(native)).toEqual(nativeBytes);
      const ordinary = join(s.root, "ordinary");
      mkdirSync(join(ordinary, "tools"), { recursive: true });
      writeFileSync(join(ordinary, "tools", name), "#!/bin/sh\nexit 73\n", { mode: 0o755 });
      const base = join(s.home, mode === "side" ? ".omp-dori" : ".dori");
      const prompt = "literal ; $(touch relative-suffix-ran)";
      const child = Bun.spawnSync([join(base, "bin/omp"), "probe", prompt], { cwd: ordinary, env });
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe("");
      const argv = child.stdout.toString().split("\0").slice(0, -1);
      expect(isAbsolute(argv[0]!)).toBe(true);
      expect(resolve(argv[0]!)).toBe(native);
      expect(argv.slice(1)).toEqual([
        ...(mode === "side"
          ? ["--no-extensions", "-e", join(s.src, "extension"), "-e", s.ulw, "--config", join(base, "omp.yml")]
          : []),
        "probe",
        prompt,
      ]);
      expect(existsSync(join(ordinary, "relative-suffix-ran"))).toBe(false);
      expect(readFileSync(native)).toEqual(nativeBytes);
    },
  );
}

test("a missing explicit override stops before installation instead of selecting PATH omp", () => {
  const s = setup();
  const installed = Bun.spawnSync([script], {
    cwd: s.root,
    env: s.env({ DORI_INSTALL_MODE: "side", DORI_NO_PULL: "1", DORI_OMP: "./missing tools/omp" }),
  });
  expect(installed.exitCode).toBe(1);
  expect(installed.stderr.toString()).toContain("DORI_OMP does not name an executable");
  expect(existsSync(join(s.home, ".omp-dori"))).toBe(false);
});

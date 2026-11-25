import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { snapshot } from "../scripts/consumer-smoke-inspect.ts";
import { git, posix, setup } from "./install-setup.ts";

const MAIN_RS = 'fn main() { println!("incoming native"); }\n';

function writeCrate(dir: string): void {
  mkdirSync(join(dir, "native/src"), { recursive: true });
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "cataly"\nversion = "0.1.0"\n');
  writeFileSync(join(dir, "Cargo.lock"), "version = 4\n");
  writeFileSync(join(dir, "native/src/main.rs"), MAIN_RS);
}

/**
 * An installed checkout whose next install requires the native binary: with `pull`, upstream gains the Rust crate and
 * the default pulling install would fast-forward to it; otherwise the checkout itself gains it under CATALY_NO_PULL=1.
 */
function installedWithCrate(pull: boolean) {
  const fixture = setup();
  expect(fixture.install({ CATALY_NO_PULL: "1" }).code).toBe(0);
  if (pull) {
    writeCrate(fixture.upstream);
    git(fixture.upstream, "add", ".");
    git(fixture.upstream, "commit", "-qm", "rust crate");
  } else writeCrate(fixture.src);
  const head = git(fixture.src, "rev-parse", "HEAD");
  const before = snapshot(fixture.home);
  const pullEnv = { CATALY_NO_PULL: pull ? "" : "1" };
  // The checkout must not move and nothing in the installation home may change.
  const unchanged = () => {
    expect(git(fixture.src, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(fixture.src, "Cargo.toml"))).toBe(!pull);
    expect(snapshot(fixture.home)).toBe(before);
    expect(existsSync(join(fixture.home, ".cataly/bin/cataly-native"))).toBe(false);
  };
  return { ...fixture, pullEnv, unchanged };
}

function stub(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
  chmodSync(join(bin, name), 0o755);
}

const rustcStub = "printf 'rustc 1.0.0\\nhost: x86_64-unknown-linux-gnu\\n'\n";

const withoutRust = (process.env["PATH"] ?? "")
  .split(delimiter)
  .filter((dir) => dir && !existsSync(join(dir, "cargo")) && !existsSync(join(dir, "rustc")))
  .join(delimiter);
const noRustTest = test.skipIf(
  process.platform === "win32" || !Bun.which("git", { PATH: withoutRust }) || !Bun.which("bash", { PATH: withoutRust }),
);

for (const pull of [false, true]) {
  const how = pull ? "pulling" : "with CATALY_NO_PULL=1";

  noRustTest(`${how}, a missing Rust toolchain fails with guidance and changes nothing`, () => {
    const { root, install, pullEnv, unchanged } = installedWithCrate(pull);

    const r = install({ ...pullEnv, PATH: `${join(root, "bin")}${delimiter}${withoutRust}` });

    expect(r.code).toBe(1);
    expect(r.err).toContain("Cataly requires its native binary");
    expect(r.err).toContain("needs a Rust toolchain");
    expect(r.err).toContain("https://rustup.rs");
    expect(r.err).toContain("linux-x64 and darwin-arm64");
    if (pull) expect(r.err).toContain("stays at its current commit");
    unchanged();
  });

  posix(`${how}, a failed Cargo build stops before anything is replaced and removes its build directory`, () => {
    const { root, install, pullEnv, unchanged } = installedWithCrate(pull);
    stub(join(root, "bin"), "rustc", rustcStub);
    stub(join(root, "bin"), "cargo", "echo 'error: fixture build failure' >&2\nexit 101\n");
    const scratch = join(root, "tmp");
    mkdirSync(scratch);

    const r = install({ ...pullEnv, TMPDIR: scratch });

    expect(r.code).toBe(1);
    expect(r.err).toContain("error: fixture build failure");
    expect(r.err).toContain("building it with Cargo failed");
    expect(r.err).toContain("install a Cataly release");
    unchanged();
    expect(readdirSync(scratch).filter((name) => name.startsWith("cataly-native-build."))).toEqual([]);
  });
}

posix("a pulling install builds the incoming commit's binary before fast-forwarding, then installs it", () => {
  const { root, src, upstream, home, install } = installedWithCrate(true);
  // The fixture binary records the tree Cargo ran in and that tree's main.rs.
  stub(join(root, "bin"), "rustc", rustcStub);
  stub(
    join(root, "bin"),
    "cargo",
    [
      "while [ $# -gt 0 ]; do",
      '  case "$1" in --target) target="$2"; shift ;; --target-dir) dir="$2"; shift ;; esac',
      "  shift",
      "done",
      'out="$dir/$target/release"',
      'mkdir -p "$out"',
      '{ printf "#!/bin/sh\\n# built in %s\\n" "$PWD"; sed "s/^/# /" native/src/main.rs; } > "$out/cataly"',
      'chmod 755 "$out/cataly"',
      "",
    ].join("\n"),
  );

  const r = install();

  expect(r.code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
  const installed = readFileSync(join(home, ".cataly/bin/cataly-native"), "utf8");
  expect(installed).toContain(`# ${MAIN_RS.trim()}`);
  expect(installed).not.toContain(`# built in ${src}\n`);
});

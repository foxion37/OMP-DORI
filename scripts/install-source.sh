#!/usr/bin/env bash
# Installs a Cataly source checkout: skill CLI, harness sources and extension.
# CATALY_NO_PULL=1 (or true, yes) installs an existing checkout without updating it.
# --preview shows only configuration changes, without updating checkouts, dependencies or references.
# CATALY_INSTALL_MODE=primary installs into ~/.cataly; CATALY_INSTALL_MODE=side installs next to another Cataly, in
# OMP_CATALY_HOME (default ~/.omp-cataly), without changing ~/.cataly, the cataly command or the cataly-mode skill.
# Without CATALY_INSTALL_MODE, a ~/.cataly owned by another Cataly is never changed: a terminal is asked, anything else stops.
# Consumer-managed ~/.cataly homes use cataly update; primary source installation always holds there.
# Optional paths: CATALY_SRC, SKILLS_DIR, OMP_EXTENSIONS_DIR, OMP_CATALY_HOME, OMP_CATALY_BIN_DIR.
# The native Cataly binary is required: the checkout's native-bin/<platform>-<arch>/cataly, or a Cargo build of its
# Rust crate (of the incoming commit, before a pull moves the checkout). Without either, the install stops before
# moving the checkout or changing links, wrappers or configuration.
set -euo pipefail

fail() { echo "$1" >&2; exit 1; }
preview=0
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 1 ] && [ "$1" = --preview ] || fail "Usage: scripts/install-source.sh [--preview]"
  preview=1
  export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
fi
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
at_least() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | { read -r first; printf '%s\n' "$first"; })" = "$1" ]; }

repo="https://github.com/vntrevx/Cataly.git"
current_primary="$HOME/.cataly"
current_side="$HOME/.omp-cataly"
primary_home="$current_primary"
side_home="$(absolute "${OMP_CATALY_HOME:-$current_side}")"
skills="$(absolute "${SKILLS_DIR:-$HOME/.agents/skills}")"
extensions="$(absolute "${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}")"
bin_dir="$(absolute "${OMP_CATALY_BIN_DIR:-${BUN_INSTALL:-$HOME/.bun}/bin}")"
min_bun="1.4.4"
min_omp="19.0.0"

command -v git >/dev/null || fail "git is required"
bun_bin="$(command -v bun)" || fail "bun $min_bun+ is required: https://bun.sh"
bun_bin="$(absolute "$bun_bin")"
bun_version="$("$bun_bin" --version)"
at_least "$min_bun" "$bun_version" || fail "bun $bun_version is older than $min_bun"
# An explicit external OMP command is an advanced override, never evidence for the bundled source.
omp_bin="${CATALY_OMP:-}"
if [ "$preview" = 0 ] && [ -n "$omp_bin" ]; then
  omp_bin="$(command -v "$omp_bin")" || fail "CATALY_OMP does not name an executable"
  omp_bin="$(absolute "$omp_bin")"
fi

present() { [ -e "$1" ] || [ -L "$1" ]; }
owned_directory() { [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }
mode_marker() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ "$(cat "$1")" = "$2" ]
}
source_checkout() {
  [ -e "$1/.git" ] && [ -f "$1/native-omp.lock" ] && [ -f "$1/skills/cataly-mode/scripts/src/cli.ts" ]
}
# These control paths and the active source pointer are owned by src/release/files.ts, not source installs.
consumer_home() {
  local result
  result="$("$bun_bin" -e '
    const { lstatSync, readlinkSync, realpathSync } = require("node:fs");
    const { dirname, join, resolve } = require("node:path");
    const base = resolve(process.argv[1]);
    const stat = lstatSync(base, { throwIfNoEntry: false });
    if (!stat?.isDirectory() && !stat?.isSymbolicLink()) process.exit(0);
    // Presence also holds interrupted or damaged control records; source installation never repairs them.
    const controls = ["consumer-owner.json", "consumer-installed.json", "consumer-journal.json"];
    let managed = controls.some(name => lstatSync(join(base, "releases", name), { throwIfNoEntry: false }));
    if (lstatSync(join(base, "src"), { throwIfNoEntry: false })?.isSymbolicLink()) {
      const physical = realpathSync(base);
      const target = resolve(physical, readlinkSync(join(base, "src")));
      managed ||= dirname(target) === join(physical, "releases/releases");
      if (!managed) {
        try {
          // Resolve only the parent; the release itself may be absent or unreadable.
          managed = realpathSync(dirname(target)) === join(physical, "releases/releases");
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
      }
    }
    if (managed) console.log("consumer");
  ' "$1")" || fail "Could not inspect consumer ownership at $1; nothing was changed."
  [ "$result" = consumer ]
}
consumer=""
if consumer_home "$current_primary"; then consumer="$current_primary"; fi

# Markerless primary installs must have either the in-home checkout or both of their
# entry points; an arbitrary extension link is not evidence about a config home.
linked_primary_source() {
  local root="$1" checkout
  [ -L "$extensions/omp-cataly" ] && [ -L "$bin_dir/cataly" ] || return 1
  checkout="$(cd -P "$extensions/omp-cataly" && cd .. && pwd -P)" || return 1
  source_checkout "$checkout" || return 1
  if [ "$bin_dir/cataly" -ef "$checkout/skills/cataly-mode/scripts/src/cli.ts" ] ||
    { mode_marker "$root/.omp-cataly" primary && [ "$bin_dir/cataly" -ef "$root/bin/cataly" ]; }; then
    printf '%s\n' "$checkout"
  else
    return 1
  fi
}

consumer_hold="$consumer is managed by the consumer release installer; nothing was changed. Use $consumer/bin/cataly update check|install|status|rollback for releases, or CATALY_INSTALL_MODE=side with scripts/install-source.sh from a separate ordinary checkout."
other_cataly() {
  [ -n "$consumer" ] && return 0
  mode_marker "$primary_home/.omp-cataly" primary && return 1
  owned_directory "$primary_home/src" && source_checkout "$primary_home/src" && return 1
  linked_primary_source "$primary_home" >/dev/null 2>&1 && return 1
  present "$primary_home/config.json" && return 0
  present "$primary_home/src/.git" && return 0
  return 1
}
other=""
other_cataly && other=1

mode="${CATALY_INSTALL_MODE:-}"
case "$mode" in "" | primary | side) ;; *) fail "CATALY_INSTALL_MODE=$mode: use primary or side" ;; esac
if [ -z "$mode" ]; then
  if mode_marker "$side_home/.omp-cataly" side; then
    mode=side
  elif [ -n "$consumer" ]; then
    fail "$consumer_hold"
  elif [ -z "$other" ]; then
    mode=primary
  elif [ -t 0 ]; then
    cat >&2 <<EOF
$primary_home belongs to another Cataly installation.
  1) primary  install omp-cataly into $primary_home. It takes over the cataly command, the cataly-mode skill link
              and $primary_home/config.json; copies of the previous ones are kept under $primary_home/backups.
  2) side     install omp-cataly into $side_home, next to it. $primary_home, the cataly command and the
              cataly-mode skill stay as they are; this installation is used through the omp-cataly command.
EOF
    read -r -p "Install as 1 or 2 [2]: " answer || fail "no answer; nothing was changed"
    case "${answer:-2}" in
      1 | primary) mode=primary ;;
      2 | side) mode=side ;;
      *) fail "unknown answer: $answer" ;;
    esac
  else
    fail "$primary_home belongs to another Cataly installation, so nothing was changed. Run scripts/install-source.sh in a terminal to choose, or set CATALY_INSTALL_MODE=side (install into $side_home next to it) or CATALY_INSTALL_MODE=primary (take over $primary_home)."
  fi
fi
if [ "$mode" = primary ] && [ -n "$consumer" ]; then fail "$consumer_hold"; fi

if [ "$mode" = side ]; then base="$side_home"; else base="$primary_home"; fi
source_default="$base/src"
if [ -z "${CATALY_SRC:-}" ] && ! present "$source_default" && [ "$mode" = primary ]; then
  discovered="$(linked_primary_source "$base" 2>/dev/null || true)"
  if [ -n "$discovered" ]; then source_default="$discovered"; fi
fi
src="$(absolute "${CATALY_SRC:-$source_default}")"
config="$base/config.json"
primary_cli="$src/skills/cataly-mode/scripts/src/cli.ts"
configuration_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/source-configuration.ts"
configuration() {
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$bun_bin" "$configuration_helper" "$1" "$base" "$src" "$mode"
}


# Resolve the install mode before checking every wrapper it writes. File identity follows symlinks,
# including aliased parents, and catches hard links without trusting an existing wrapper's source.
check_omp_wrapper_collision() {
  local name command_link traverses
  local wrappers=(omp) command_links
  if [ "$mode" = side ]; then
    wrappers+=(cataly omp-cataly)
    command_links=("$bin_dir/omp-cataly")
  else
    command_links=("$bin_dir/cataly")
  fi
  for name in "${wrappers[@]}"; do
    if [ "$omp_bin" -ef "$base/bin/$name" ]; then
      fail "Selected OMP executable $omp_bin aliases generated wrapper $base/bin/$name; choose an independent executable with CATALY_OMP."
    fi
  done
  for command_link in "${command_links[@]}"; do
    [ -L "$command_link" ] || continue
    # Relinking changes a pathname, not its target inode. Preserve independent paths to that same target.
    traverses="$("$bun_bin" -e '
      const { lstatSync, readlinkSync, realpathSync } = require("node:fs");
      const { basename, dirname, isAbsolute, join } = require("node:path");
      const target = join(realpathSync(dirname(process.argv[2])), basename(process.argv[2]));
      const pending = process.argv[1].split("/");
      let current = "/", links = 0;
      while (pending.length) {
        const part = pending.shift();
        if (!part || part === ".") continue;
        if (part === "..") { current = dirname(current); continue; }
        const next = join(current, part);
        if (next === target) { console.log("yes"); break; }
        if (lstatSync(next).isSymbolicLink()) {
          if (++links > 40) throw new Error("Too many native executable symbolic links");
          const destination = readlinkSync(next);
          if (isAbsolute(destination)) current = "/";
          pending.unshift(...destination.split("/"));
        } else {
          current = next;
        }
      }
    ' "$omp_bin" "$command_link")" || fail "Could not inspect selected OMP path $omp_bin before command publication."
    [ "$traverses" != yes ] || fail "Selected OMP executable $omp_bin traverses installation command link $command_link; choose an independent executable with CATALY_OMP."
  done
}

consumer_home "$base" && fail "$base is a consumer-managed home; choose a separate OMP_CATALY_HOME."
if [ "$mode" = side ]; then
  protected=("$current_primary")
  destinations=("$base" "$src" "$src/skills/cataly-mode/scripts" "$src/extension" "$bin_dir"
    "$base/config.json" "$base/.omp-cataly" "$base/env.sh" "$base/omp.yml"
    "$base/skills" "$base/skills/omp-cataly-mode" "$base/state" "$base/bin"
    "$base/bin/cataly" "$base/bin/cataly-native" "$base/bin/omp" "$base/bin/omp-cataly")
else
  protected=("$current_side")
  destinations=("$base" "$src" "$src/skills/cataly-mode/scripts" "$src/extension" "$bin_dir"
    "$base/bin" "$base/bin/cataly-native" "$base/bin/omp" "$skills" "$extensions")
fi
if [ -n "$omp_bin" ]; then destinations+=("$omp_bin"); fi
# Resolve existing links and missing suffixes before any checkout, dependency or config mutation.
CATALY_PROTECTED_COUNT="${#protected[@]}" "$bun_bin" -e '
    const { lstatSync, readlinkSync } = require("node:fs");
    const { dirname, join, relative, resolve } = require("node:path");
    const physical = (value) => {
      const parts = value.split("/");
      let path = "/", links = 0;
      while (parts.length) {
        const part = parts.shift();
        if (!part || part === ".") continue;
        if (part === "..") { path = dirname(path); continue; }
        const next = join(path, part);
        if (lstatSync(next, { throwIfNoEntry: false })?.isSymbolicLink()) {
          if (++links > 40) throw new Error(`Too many links in installation path: ${value}`);
          const target = readlinkSync(next);
          if (target.startsWith("/")) path = "/";
          parts.unshift(...target.split("/"));
        } else {
          path = next;
        }
      }
      return path;
    };
    const paths = process.argv.slice(1), separator = Number(process.env.CATALY_PROTECTED_COUNT);
    const protectedRoots = paths.slice(0, separator).map(root => [root, physical(root)]);
    for (const value of paths.slice(separator)) {
      const resolved = physical(value);
      if (resolved !== physical(resolve(value))) {
        console.error(`${value} uses a directory link followed by ".."; select its absolute path instead; nothing was changed.`);
        process.exit(1);
      }
      for (const [root, protectedPath] of protectedRoots) {
        const entry = relative(protectedPath, resolved);
        if (entry === "" || (entry !== ".." && !entry.startsWith("../"))) {
          console.error(`${value} belongs to ${root}; choose separate installation paths (CATALY_SRC, OMP_CATALY_HOME and OMP_CATALY_BIN_DIR); nothing was changed.`);
          process.exit(1);
        }
      }
    }
  ' "${protected[@]}" "${destinations[@]}"

generated_directories=("$base/bin" "$base/backups")
if [ "$mode" = side ]; then
  generated_directories+=("$base/skills" "$base/skills/omp-cataly-mode" "$base/state")
fi
for directory in "${generated_directories[@]}"; do
  if present "$directory" && ! owned_directory "$directory"; then
    fail "$directory is not an owned directory; nothing was changed."
  fi
done

# A linked worktree has a .git file rather than a directory.
if [ -z "${CATALY_SRC:-}" ] && [ "$src" = "$base/src" ] && [ -L "$src" ]; then
  fail "$src is a source link; select an ordinary checkout explicitly with CATALY_SRC."
fi
if [ -e "$src/.git" ] && ! source_checkout "$src"; then
  fail "$src is a checkout of $(git -C "$src" remote get-url origin 2>/dev/null || echo 'another repository'), not Cataly; nothing was changed. Move it aside, set CATALY_SRC, or install with CATALY_INSTALL_MODE=side."
fi

if [ "$preview" = 1 ]; then
  configuration preview
  exit 0
fi

# The one-way bridge from previous installations (scripts/previous-install, from the checkout being installed). Its
# import converts a home an earlier version wrote and carries an earlier home's settings over; it runs before the
# configuration snapshot, so they are part of it, and before any toolchain, checkout, link or wrapper change.
bridge="$src/scripts/previous-install/cli.ts"
if [ -f "$bridge" ]; then
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$bun_bin" "$bridge" import --home "$base" --mode "$mode" ||
    fail "Import of the previous installation into $base held; nothing was changed."
fi
# Capture before toolchain/checkout/dependency preparation; the receipt contains metadata, never file content.
setup_snapshot="$(configuration capture)"
# After a successful install the same bridge removes what earlier versions left behind, deletes an earlier home whose
# settings are here and of which nothing runs, and hands a managed deployment still on the previous main's controller
# to this one. A held cleanup is reported and retried by the next install; the installation itself succeeded.
retire_previous() {
  [ -f "$bridge" ] || return 0
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$bun_bin" "$bridge" retire --home "$base" --mode "$mode" --source "$src" ||
    echo "Previous installation cleanup held for $base; the next install retries" >&2
}

if [ -n "$omp_bin" ]; then
  check_omp_wrapper_collision
  omp_version="$("$omp_bin" --version)"
  [[ "$omp_version" =~ ([0-9]+(\.[0-9]+){2}) ]] || fail "could not read CATALY_OMP version"
  at_least "$min_omp" "${BASH_REMATCH[1]}" || fail "CATALY_OMP must be $min_omp or newer"
fi
(umask 077; mkdir -p "$base")

# The native Cataly binary is required. Obtain it for the tree being installed before any dependency, link, wrapper
# or configuration change and, when pulling, before the checkout moves: a host that cannot provide it leaves the
# existing installation running its current commit.
native_controller=""
native_prepared=""
native_build_dir=""
trap '[ -z "$native_build_dir" ] || rm -rf "$native_build_dir"' EXIT
# prepare_native_controller TREE UNCHANGED: TREE is the source that will be installed; UNCHANGED ends failure messages.
prepare_native_controller() {
  local tree="$1" unchanged="$2" host candidate rust_host release
  native_prepared=1
  host="$("$bun_bin" -e 'console.log(`${process.platform}-${process.arch}`)')"
  # A packaged binary is never committed (release-only path), so it is read from the checkout itself.
  candidate="$src/native-bin/$host/cataly"
  if present "$candidate"; then
    [ ! -L "$src/native-bin" ] && [ ! -L "$src/native-bin/$host" ] ||
      fail "Native Cataly package must not traverse a directory link: $candidate"
    native_controller="$candidate"
  else
    # Source trees from before the Rust crate have no native binary to install.
    [ -f "$tree/Cargo.toml" ] && [ -f "$tree/Cargo.lock" ] && [ -f "$tree/native/src/main.rs" ] || return 0
    release="or install a Cataly release, which bundles the binary for linux-x64 and darwin-arm64"
    if ! command -v cargo >/dev/null || ! rust_host="$(rustc -vV 2>/dev/null | awk '$1 == "host:" { print $2 }')" ||
      [[ ! "$rust_host" =~ ^[a-zA-Z0-9_-]+$ ]]; then
      fail "Cataly requires its native binary: $src has no native-bin/$host/cataly, and building it needs a Rust toolchain (cargo and rustc). Install Rust with rustup (https://rustup.rs) and run this installer again, $release. $unchanged"
    fi
    [ -n "$native_build_dir" ] || native_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/cataly-native-build.XXXXXX")"
    if ! (cd "$tree" && cargo build --locked --release --bin cataly --target "$rust_host" --target-dir "$native_build_dir/target"); then
      fail "Cataly requires its native binary, and building it with Cargo failed; cargo's message above says why. Fix the build (rustup update installs a current Rust) and run this installer again, $release. $unchanged"
    fi
    native_controller="$native_build_dir/target/$rust_host/release/cataly"
  fi
  [ -f "$native_controller" ] && [ -x "$native_controller" ] && [ ! -L "$native_controller" ] ||
    fail "Native Cataly is not an executable regular file: $native_controller"
}

if [ ! -e "$src/.git" ]; then
  (umask 077; git clone --quiet --depth 1 "$repo" "$src")
elif [[ "${CATALY_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "CATALY_NO_PULL=$CATALY_NO_PULL: installing $src as it is, without pulling" >&2
elif ! (umask 077; git -C "$src" fetch --quiet); then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
else
  # Build the incoming commit's binary from an export of that commit while the checkout still runs the current one.
  # A diverged checkout skips this and reports its local work below.
  if incoming="$(git -C "$src" rev-parse --verify --quiet '@{u}^{commit}')" &&
    [ "$incoming" != "$(git -C "$src" rev-parse HEAD)" ] &&
    git -C "$src" merge-base --is-ancestor HEAD "$incoming"; then
    native_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/cataly-native-build.XXXXXX")"
    mkdir "$native_build_dir/source"
    git -C "$src" archive --format=tar "$incoming" | tar -xf - -C "$native_build_dir/source"
    prepare_native_controller "$native_build_dir/source" \
      "$src stays at its current commit; links, wrappers and configuration were not changed."
  fi
  if ! (umask 077; git -C "$src" merge --ff-only --quiet '@{u}'); then
    if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null &&
      [ -n "$(git -C "$src" status --porcelain)$(git -C "$src" rev-list '@{u}..HEAD')" ]; then
      echo "Could not update $src. Local work in that checkout:" >&2
      git -C "$src" status --short --branch >&2
      git -C "$src" log --oneline '@{u}..HEAD' >&2
      echo "To keep it and install the checkout as it is, run scripts/install-source.sh again with CATALY_NO_PULL=1." >&2
    else
      echo "Could not update $src; git's message above says why." >&2
    fi
    exit 1
  fi
fi
[ -f "$src/skills/cataly-mode/scripts/src/cli.ts" ] ||
  fail "$src has no Cataly skill CLI; select a Cataly checkout with CATALY_SRC."
[ -n "$native_prepared" ] ||
  prepare_native_controller "$src" "Links, wrappers and configuration were not changed."
if [ -z "$omp_bin" ]; then
  # The installer holds the native cache lease until it has written the wrapper below that names the identity.
  native="$(CATALY_NATIVE_LEASE_PID=$$ "$bun_bin" "$src/scripts/source-dependencies.ts" native "$src" "$HOME")"
  omp_bin="$native/bin/omp"
  check_omp_wrapper_collision
else
  # An explicit executable inside the native cache is leased by the installer too before a wrapper names it.
  CATALY_NATIVE_LEASE_PID=$$ "$bun_bin" "$src/scripts/source-dependencies.ts" lease-path "$src" "$HOME" "$omp_bin"
fi

if [ "$mode" = primary ] && { [ -n "$other" ] ||
  { [ -L "$bin_dir/cataly" ] && [ ! "$bin_dir/cataly" -ef "$primary_cli" ]; }; }; then
  backup="$primary_home/backups/omp-cataly-install-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  [ -f "$primary_home/config.json" ] && cp -p "$primary_home/config.json" "$backup/config.json"
  for path in "$skills/cataly-mode" "$bin_dir/cataly" "$(command -v cataly || echo "$bin_dir/cataly")"; do
    printf '%s -> %s\n' "$path" "$(readlink "$path" 2>/dev/null || echo '(not a link)')"
  done | sort -u > "$backup/links.txt"
  echo "The previous config.json and link targets are kept in $backup" >&2
fi

link() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "$2 exists and is not a link; leaving it alone" >&2
    return 1
  fi
  ln -sfn "$1" "$2"
}

# Publish generated files independently of any existing hard links. Never traverse a destination link.
write_generated() (
  local path="$1" permission="$2" scratch
  if present "$path" && { [ ! -f "$path" ] || [ -L "$path" ] || [ ! -O "$path" ]; }; then
    fail "$path is not an owned regular file; nothing was written there."
  fi
  scratch="$(mktemp "${path}.XXXXXX")"
  trap 'rm -f "$scratch"' EXIT
  cat > "$scratch"
  chmod "$permission" "$scratch"
  mv -f "$scratch" "$path"
)

install_native_controller() {
  [ -n "$native_controller" ] || return 0
  (umask 077; mkdir -p "$base/bin")
  write_generated "$base/bin/cataly-native" 700 < "$native_controller"
}

if [ "$mode" = primary ]; then
  mkdir -p "$skills" "$extensions"
  link "$src/skills/cataly-mode" "$skills/cataly-mode" || true
  link "$src/extension" "$extensions/omp-cataly" || fail "extension link was not installed"
fi

# In primary mode the skill owns the installed cataly name; a side install never links a global cataly.
(cd "$src" && "$bun_bin" install --frozen-lockfile --silent)
(cd "$src/skills/cataly-mode/scripts" && "$bun_bin" install --frozen-lockfile --silent)
(cd "$src/extension" && "$bun_bin" install --frozen-lockfile --silent)
if [ "$mode" = primary ] && [ "$bin_dir/cataly" != "$primary_cli" ]; then
  if [ -e "$bin_dir/cataly" ] && [ ! -L "$bin_dir/cataly" ]; then
    fail "$bin_dir/cataly exists and is not a link; leaving it alone. Choose another OMP_CATALY_BIN_DIR."
  fi
fi
install_native_controller

setup_snapshot="$(CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration publish-json)"
printf '%s\n' "$mode" | write_generated "$base/.omp-cataly" 600

agent_argv="$("$bun_bin" -e 'console.log(JSON.stringify([process.argv[1]]))' "$base/bin/omp")"
if [ "$mode" = primary ]; then
  mkdir -p "$base/bin"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'if [ "${CATALY_HOME+x}" = "" ]; then export CATALY_HOME=%q; fi\n' "$base"
    printf '%s\n' 'if [ "${CATALY_CONFIG+x}" = "" ]; then export CATALY_CONFIG="$CATALY_HOME/config.json"; fi'
    printf 'exec %q "$@"\n' "$omp_bin"
  } | write_generated "$base/bin/omp" 755
  if [ "$bin_dir/cataly" != "$primary_cli" ]; then
    mkdir -p "$bin_dir"
    link "$primary_cli" "$bin_dir/cataly" ||
      fail "cataly command was not installed; choose another OMP_CATALY_BIN_DIR."
  fi
  CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration readback
  cat <<EOF
Installed.
  Skill:     $skills/cataly-mode
  Extension: $extensions/omp-cataly
  CLI:       cataly (messenger/lane CLI), cataly harness (upstream harness)
  Config:    $config
Next: configure your model, project and messenger hooks in $config.
Sessions run on headless OMP.
Run cataly harness up from your project to start the harness, or open the lead with
$base/bin/omp --cataly-role cataly. Installation does not start a messenger or watcher.
EOF
  retire_previous
  exit 0
fi

skill="$base/skills/omp-cataly-mode"
mkdir -p "$base/bin" "$base/state" "$base/skills"
mkdir -p "$skill"
# omp lists one of two skills with the same description, so the copy changes its description as well as its name.
awk 'NR == 1 { print; next }
  !done && /^name: cataly-mode$/ { print "name: omp-cataly-mode"; next }
  !done && /^description: / { sub(/^description: /, "description: For the omp-cataly installation next to another Cataly (omp-cataly command). "); print; next }
  !done && /^---$/ { done = 1 }
  { print }' "$src/skills/cataly-mode/SKILL.md" | write_generated "$skill/SKILL.md" 644
for part in references scripts assets; do
  if [ -e "$src/skills/cataly-mode/$part" ]; then
    link "$src/skills/cataly-mode/$part" "$skill/$part"
  fi
done
# Only the generated skills keys and update.auto below belong to this installer; other keys belong to the owner.
if ! setup_snapshot="$(CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration publish-yaml)"; then
  fail "Configuration setup held for $base/omp.yml; inspect the file and rerun --preview before retrying."
fi
{
  printf 'export CATALY_HOME=%q\n' "$base"
  printf 'export CATALY_CONFIG=%q\n' "$config"
  printf 'export CATALY_STATE_DIR=%q\n' "$base/state"
  printf '%s\n' 'unset CATALY_AGENT_CMD CATALY_AGENT_EXECUTABLE'
  printf 'export CATALY_AGENT_ARGV=%q\n' "$agent_argv"
  printf 'case ":$PATH:" in *:%q:*) ;; *) export PATH=%q:"$PATH" ;; esac\n' "$base/bin" "$base/bin"
} | write_generated "$base/env.sh" 644
wrapper() {
  { printf '#!/usr/bin/env bash\nset -euo pipefail\n. %q\n' "$base/env.sh"; cat; } | write_generated "$base/bin/$1" 755
}
printf 'exec %q %q "$@"\n' "$bun_bin" "$src/skills/cataly-mode/scripts/src/cli.ts" | wrapper cataly
printf 'exec %q --no-extensions -e %q --config %q "$@"\n' "$omp_bin" "$src/extension" "$base/omp.yml" | wrapper omp
printf 'case "${1:-}" in\n  omp) shift; exec %q "$@" ;;\n  *) exec %q "$@" ;;\nesac\n' \
  "$base/bin/omp" "$base/bin/cataly" | wrapper omp-cataly
mkdir -p "$bin_dir"
if [ "$bin_dir/omp-cataly" != "$base/bin/omp-cataly" ]; then
  link "$base/bin/omp-cataly" "$bin_dir/omp-cataly" || echo "Run $base/bin/omp-cataly directly." >&2
fi

CATALY_SETUP_SNAPSHOT="$setup_snapshot" configuration readback
cat <<EOF
Installed next to the Cataly in $primary_home, which was not changed.
  Home:       $base (config.json, state, generated skill, omp.yml and wrappers)
  Command:    $bin_dir/omp-cataly  (omp-cataly <cataly command> | omp-cataly omp ...)
  Skill:      omp-cataly-mode; cataly-mode is hidden in omp-cataly omp sessions
  Extension:  $src/extension, loaded only by omp-cataly omp, which discovers no other OMP extension
  Config:     $config
Next: configure your model and project in $config and use separate messenger credentials and hooks for this home.
Sessions run on headless OMP.
Run omp-cataly harness up from your project to start the harness, or open the lead with
omp-cataly omp --cataly-role cataly. Installation does not start a messenger or watcher.
EOF
retire_previous

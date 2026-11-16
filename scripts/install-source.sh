#!/usr/bin/env bash
# Installs an OMP Dori source checkout: skill CLI, harness sources, extension, and source-selected omp-ulw.
# DORI_NO_PULL=1 (or true, yes) installs an existing checkout without updating it.
# DORI_INSTALL_MODE=primary installs into ~/.dori; DORI_INSTALL_MODE=side installs next to another Dori, in
# OMP_DORI_HOME (default ~/.omp-dori), without changing ~/.dori, the dori command or the dori-mode skill.
# Without DORI_INSTALL_MODE, a ~/.dori owned by another Dori is never changed: a terminal is asked, anything else stops.
# Consumer-managed ~/.dori homes use dori update; primary source installation always holds there.
# Source omp-ulw uses the bound lock+overlay by default; OMP_ULW_REF explicitly selects an unpatched branch/tag/commit.
# Primary mode discovers it globally; side mode loads it only through the isolated omp-dori omp wrapper.
# Optional paths: DORI_SRC, OMP_ULW_SRC, OMP_ULW_REPO, SKILLS_DIR, OMP_EXTENSIONS_DIR, OMP_DORI_HOME, OMP_DORI_BIN_DIR.
# Side mode also takes OMP_DORI_HC_SESSION (default omp-dori) and OMP_DORI_HC_SPACE (a Herdr app space id).
set -euo pipefail

fail() { echo "$1" >&2; exit 1; }
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
at_least() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | { read -r first; printf '%s\n' "$first"; })" = "$1" ]; }

repo="https://github.com/vntrevx/omp-dori.git"
ulw_repo="${OMP_ULW_REPO:-https://github.com/dbc-hbin/omp-ulw.git}"
ulw_ref="${OMP_ULW_REF:-lock}"
primary_home="$HOME/.dori"
side_home="$(absolute "${OMP_DORI_HOME:-$HOME/.omp-dori}")"
min_bun="1.4.4"
min_omp="18.18.8"

command -v git >/dev/null || fail "git is required"
command -v bun >/dev/null || fail "bun $min_bun+ is required: https://bun.sh"
bun_version="$(bun --version)"
at_least "$min_bun" "$bun_version" || fail "bun $bun_version is older than $min_bun"
# An explicit external OMP command is an advanced override, never evidence for the bundled source.
omp_bin="${DORI_OMP:-}"
if [ -n "$omp_bin" ]; then
  omp_bin="$(command -v "$omp_bin")" || fail "DORI_OMP does not name an executable"
  omp_bin="$(absolute "$omp_bin")"
fi

# Every install of this repository leaves a marker in its home. Installs that predate it are known by the
# omp-dori checkout in ~/.dori/src or by the omp-dori extension link every earlier source installer created.
# A checkout is omp-dori by its files, whatever its remote is named; other Doris ship no omp-ulw.lock.
marked() { [ -e "$1/.omp-dori" ]; }
earlier_extension_link="$(absolute "${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}")/omp-dori"
is_omp_dori() { [ -f "$1/omp-ulw.lock" ] && [ -f "$1/skills/dori-mode/scripts/src/cli.ts" ]; }
# These control paths and the active source pointer are owned by src/release/files.ts, not source installs.
consumer_home() {
  local result
  result="$(bun -e '
    const { lstatSync, readlinkSync, realpathSync } = require("node:fs");
    const { dirname, join, resolve } = require("node:path");
    const base = resolve(process.argv[1]);
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
consumer_home "$primary_home" && consumer=1
consumer_hold="$primary_home is managed by the consumer release installer; nothing was changed. Use $primary_home/bin/dori update check|install|status|rollback for releases, or DORI_INSTALL_MODE=side with scripts/install-source.sh from a separate ordinary checkout."
other_dori() {
  [ -n "$consumer" ] && return 0
  marked "$primary_home" && return 1
  [ -L "$earlier_extension_link" ] && return 1
  [ -e "$primary_home/src/.git" ] && is_omp_dori "$primary_home/src" && return 1
  [ -f "$primary_home/config.json" ] && return 0
  [ -e "$primary_home/src/.git" ] && return 0
  return 1
}
other=""
other_dori && other=1

mode="${DORI_INSTALL_MODE:-}"
case "$mode" in "" | primary | side) ;; *) fail "DORI_INSTALL_MODE=$mode: use primary or side" ;; esac
if [ -z "$mode" ]; then
  if marked "$side_home"; then
    mode=side
  elif [ -n "$consumer" ]; then
    fail "$consumer_hold"
  elif [ -z "$other" ]; then
    mode=primary
  elif [ -t 0 ]; then
    cat >&2 <<EOF
$primary_home belongs to another Dori installation.
  1) primary  install omp-dori into $primary_home. It takes over the dori command, the dori-mode skill link
              and $primary_home/config.json; copies of the previous ones are kept under $primary_home/backups.
  2) side     install omp-dori into $side_home, next to it. $primary_home, the dori command and the
              dori-mode skill stay as they are; this installation is used through the omp-dori command.
EOF
    read -r -p "Install as 1 or 2 [2]: " answer || fail "no answer; nothing was changed"
    case "${answer:-2}" in
      1 | primary) mode=primary ;;
      2 | side) mode=side ;;
      *) fail "unknown answer: $answer" ;;
    esac
  else
    fail "$primary_home belongs to another Dori installation, so nothing was changed. Run scripts/install-source.sh in a terminal to choose, or set DORI_INSTALL_MODE=side (install into $side_home next to it) or DORI_INSTALL_MODE=primary (take over $primary_home)."
  fi
fi
if [ "$mode" = primary ] && [ -n "$consumer" ]; then fail "$consumer_hold"; fi

if [ "$mode" = side ]; then base="$side_home"; else base="$primary_home"; fi
src="$(absolute "${DORI_SRC:-$base/src}")"
ulw="$(absolute "${OMP_ULW_SRC:-$base/omp-ulw}")"
skills="$(absolute "${SKILLS_DIR:-$HOME/.agents/skills}")"
extensions="$(absolute "${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}")"
bin_dir="$(absolute "${OMP_DORI_BIN_DIR:-${BUN_INSTALL:-$HOME/.bun}/bin}")"

# Resolve the install mode before checking every wrapper it writes. File identity follows symlinks,
# including aliased parents, and catches hard links without trusting an existing wrapper's source.
check_omp_wrapper_collision() {
  local name command_link traverses
  for name in omp dori omp-dori; do
    if [ "$mode" = primary ] && [ "$name" != omp ]; then continue; fi
    if [ "$omp_bin" -ef "$base/bin/$name" ]; then
      fail "Selected OMP executable $omp_bin aliases generated wrapper $base/bin/$name; choose an independent executable with DORI_OMP."
    fi
  done
  if [ "$mode" = primary ]; then command_link="$bin_dir/dori"; else command_link="$bin_dir/omp-dori"; fi
  if [ -L "$command_link" ]; then
    # Relinking changes a pathname, not its target inode. Preserve independent paths to that same target.
    traverses="$(bun -e '
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
    [ "$traverses" != yes ] || fail "Selected OMP executable $omp_bin traverses installation command link $command_link; choose an independent executable with DORI_OMP."
  fi
}
if [ -n "$omp_bin" ]; then
  check_omp_wrapper_collision
  omp_version="$("$omp_bin" --version)"
  [[ "$omp_version" =~ ([0-9]+(\.[0-9]+){2}) ]] || fail "could not read DORI_OMP version"
  at_least "$min_omp" "${BASH_REMATCH[1]}" || fail "DORI_OMP must be $min_omp or newer"
fi

# Checkouts of every supported revision have these files; older revisions have no package.json.
is_ulw() { [ -f "$1/index.ts" ] && [ -f "$1/presets.ts" ]; }
ulw_explicit="${OMP_ULW_SRC:+1}"
if [ -z "$ulw_explicit" ] && [ -f "$base/config.json" ]; then
  custom_ulw="$(CONFIG="$base/config.json" ULW_DIR="$ulw" bun -e '
    const { dirname, resolve } = require("node:path");
    const config = await Bun.file(process.env.CONFIG).json();
    const path = typeof config.ompUlwPath === "string" ? config.ompUlwPath.replace(/^~(?=\/|$)/, process.env.HOME) : "";
    const dir = path ? resolve(dirname(path)) : "";
    if (path && resolve(path) !== resolve(process.env.HOME, ".dori/omp-ulw/index.ts") && dir !== resolve(process.env.ULW_DIR)) console.log(dir);')"
  if [ -n "$custom_ulw" ]; then
    ulw="$custom_ulw"
    ulw_explicit=1
    echo "omp-ulw: config.json points at $custom_ulw; installing that checkout as the extension." >&2
  fi
fi
# A side config's import path is cleared below; retain an external checkout choice for later reinstalls.
if [ "$mode" = side ] && [ -z "$ulw_explicit" ] && [ -L "$base/.omp-dori-ulw" ]; then
  ulw="$(absolute "$(readlink "$base/.omp-dori-ulw")")"
  ulw_explicit=1
fi
if [ -n "$ulw_explicit" ]; then
  is_ulw "$ulw" || fail "$ulw is not an omp-ulw checkout (no index.ts and presets.ts); nothing was changed."
fi
standalone_ulw=""
if [ "$mode" = primary ]; then
  for entry in "$extensions"/*; do
    [ "$entry" != "$extensions/omp-dori" ] || continue
    # Only a marked source home's own default link may be replaced by a later standalone extension.
    if marked "$base" && [ "$entry" = "$extensions/omp-ulw" ]; then
      owned_ulw="$(readlink "$entry" 2>/dev/null || true)"
      case "$owned_ulw" in "$base/omp-ulw"|"$base/omp-ulw-custom") continue ;; esac
    fi
    if is_ulw "$entry"; then
      [ -z "$standalone_ulw" ] || fail "Multiple standalone omp-ulw extensions exist; keep one before source installation; nothing was changed."
      if [ -n "$ulw_explicit" ] && ! [ "$entry" -ef "$ulw" ]; then
        fail "The standalone omp-ulw at $entry differs from $ulw; select one checkout before primary source installation; nothing was changed."
      fi
      standalone_ulw="$entry"
    fi
  done
fi

if [ "$mode" = side ]; then
  consumer_home "$base" && fail "$base is a consumer-managed home; choose a separate OMP_DORI_HOME."
  if [ -e "$base/.omp-dori-ulw" ] && [ ! -L "$base/.omp-dori-ulw" ]; then
    fail "$base/.omp-dori-ulw exists and is not a link; nothing was changed."
  fi
  # Resolve existing symlinks and missing suffixes before any checkout, dependency or config mutation.
  PRIMARY_HOME="$primary_home" bun -e '
    const { lstatSync, readlinkSync, realpathSync } = require("node:fs");
    const { basename, dirname, join, relative, resolve } = require("node:path");
    const physical = (value) => {
      const path = resolve(value), stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) return physical(resolve(dirname(path), readlinkSync(path)));
      if (stat) return realpathSync(path);
      return join(physical(dirname(path)), basename(path));
    };
    const primary = physical(process.env.PRIMARY_HOME);
    for (const value of process.argv.slice(1)) {
      const entry = relative(primary, physical(value));
      if (entry === "" || (entry !== ".." && !entry.startsWith("../"))) {
        console.error(`${value} belongs to ${process.env.PRIMARY_HOME}; choose separate source, dependency, OMP_DORI_HOME and OMP_DORI_BIN_DIR paths for side mode; nothing was changed.`);
        process.exit(1);
      }
    }
  ' "$base" "$src" "$src/skills/dori-mode/scripts" "$src/extension" "$ulw" "$bin_dir" \
    "$base/config.json" "$base/.omp-dori" "$base/.omp-dori-ulw" "$base/env.sh" "$base/omp.yml" \
    "$base/skills" "$base/skills/omp-dori-mode" "$base/state" "$base/bin" \
    "$base/bin/dori" "$base/bin/omp" "$base/bin/omp-dori"
fi

# A linked worktree has a .git file rather than a directory.
if [ -z "${DORI_SRC:-}" ] && [ -e "$src/.git" ] && ! is_omp_dori "$src"; then
  fail "$src is a checkout of $(git -C "$src" remote get-url origin 2>/dev/null || echo 'another repository'), not omp-dori; nothing was changed. Move it aside, set DORI_SRC, or install with DORI_INSTALL_MODE=side."
fi

if [ ! -e "$src/.git" ]; then
  (umask 077; git clone --quiet --depth 1 "$repo" "$src")
elif [[ "${DORI_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "DORI_NO_PULL=$DORI_NO_PULL: installing $src as it is, without pulling" >&2
elif ! (umask 077; git -C "$src" fetch --quiet); then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
elif ! (umask 077; git -C "$src" merge --ff-only --quiet '@{u}'); then
  if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null &&
    [ -n "$(git -C "$src" status --porcelain)$(git -C "$src" rev-list '@{u}..HEAD')" ]; then
    echo "Could not update $src. Local work in that checkout:" >&2
    git -C "$src" status --short --branch >&2
    git -C "$src" log --oneline '@{u}..HEAD' >&2
    echo "To keep it and install the checkout as it is, run scripts/install-source.sh again with DORI_NO_PULL=1." >&2
  else
    echo "Could not update $src; git's message above says why." >&2
  fi
  exit 1
fi
if [ -z "$omp_bin" ]; then
  native="$(bun "$src/scripts/source-dependencies.ts" native "$src" "$HOME")"
  omp_bin="$native/bin/omp"
  check_omp_wrapper_collision
fi

if [ "$mode" = primary ] && { [ -n "$other" ] ||
  { [ -L "$bin_dir/dori" ] && [ ! "$bin_dir/dori" -ef "$src/skills/dori-mode/scripts/src/cli.ts" ]; }; }; then
  backup="$primary_home/backups/omp-dori-install-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  [ -f "$primary_home/config.json" ] && cp -p "$primary_home/config.json" "$backup/config.json"
  for path in "$skills/dori-mode" "$bin_dir/dori" "$(command -v dori || echo "$bin_dir/dori")"; do
    printf '%s -> %s\n' "$path" "$(readlink "$path" 2>/dev/null || echo '(not a link)')"
  done | sort -u > "$backup/links.txt"
  echo "The previous config.json and link targets are kept in $backup" >&2
fi

ulw_bound=""
if [ -n "$standalone_ulw" ]; then
  echo "omp-ulw: using the standalone extension at $standalone_ulw; omp-dori does not load a second copy." >&2
  if marked "$base"; then
    owned_ulw="$(readlink "$extensions/omp-ulw" 2>/dev/null || true)"
    case "$owned_ulw" in
      "$base/omp-ulw"|"$base/omp-ulw-custom") rm "$extensions/omp-ulw" ;;
    esac
  fi
elif [ -z "$ulw_explicit" ]; then
  if [ "$ulw_ref" = lock ]; then
    selected="$(bun "$src/scripts/source-dependencies.ts" ulw "$src" "$HOME")"
    [ ! -e "$ulw" ] || [ -L "$ulw" ] || fail "$ulw is an existing checkout; preserve it and move it aside before selecting the bound overlay."
    mkdir -p "$base"
    ln -sfn "$selected" "$ulw"
    ulw_bound=1
  else
    # Explicit branch/tag/commit overrides have their own checkout; never mutate a bound cache.
    ulw="$base/omp-ulw-custom"
    [ -e "$ulw/.git" ] || git clone --quiet "$ulw_repo" "$ulw"
    if [ -n "${OMP_ULW_REPO:-}" ]; then git -C "$ulw" remote set-url origin "$ulw_repo"; fi
    git -C "$ulw" fetch --quiet origin
    if git -C "$ulw" rev-parse --verify --quiet "origin/$ulw_ref^{commit}" >/dev/null; then target="origin/$ulw_ref"; else target="$ulw_ref"; fi
    [ -z "$(git -C "$ulw" status --porcelain)" ] || fail "Explicit omp-ulw checkout changed; preserve local work before reinstalling."
    git -C "$ulw" -c advice.detachedHead=false checkout --quiet "$target"
    is_ulw "$ulw" || fail "$ulw is not an omp-ulw checkout"
  fi
fi
if [ "$mode" = side ]; then
  ulw_extension="$ulw"
elif [ -n "$standalone_ulw" ]; then
  ulw_extension="$standalone_ulw"
else
  ulw_extension="$extensions/omp-ulw"
fi

link() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "$2 exists and is not a link; leaving it alone" >&2
    return 1
  fi
  ln -sfn "$1" "$2"
}

if [ "$mode" = primary ]; then
  mkdir -p "$skills" "$extensions"
  link "$src/skills/dori-mode" "$skills/dori-mode" || true
  link "$src/extension" "$extensions/omp-dori" || fail "extension link was not installed"
  if [ -z "$standalone_ulw" ]; then
    link "$ulw" "$extensions/omp-ulw" || fail "omp-ulw extension link was not installed"
  fi
fi

# In primary mode the skill owns the installed dori name; a side install never links a global dori.
(cd "$src" && bun install --frozen-lockfile --silent)
(cd "$src/skills/dori-mode/scripts" && bun install --frozen-lockfile --silent)
(cd "$src/extension" && bun install --frozen-lockfile --silent)
if [ "$mode" = primary ]; then
  mkdir -p "$bin_dir"
  link "$src/skills/dori-mode/scripts/src/cli.ts" "$bin_dir/dori" ||
    fail "dori command was not installed; move $bin_dir/dori aside or choose another OMP_DORI_BIN_DIR."
fi

mkdir -p "$base"
if [ "$mode" = side ] && [ -n "$ulw_explicit" ]; then
  if [ "$ulw" -ef "$base/omp-ulw" ]; then
    [ ! -L "$base/.omp-dori-ulw" ] || rm "$base/.omp-dori-ulw"
  else
    link "$ulw" "$base/.omp-dori-ulw" || fail "omp-ulw checkout choice was not saved"
  fi
fi
config="$base/config.json"
created=""
[ -f "$config" ] || { cp "$src/skills/dori-mode/references/config.example.json" "$config" && created=1; }
CONFIG="$config" CREATED="$created" SIDE_MODE="$mode" STATE_DIR="$base/state" bun -e '
  import { realpathSync } from "node:fs";
  import { dirname, join } from "node:path";
  const path = process.env.CONFIG;
  const config = await Bun.file(path).json();
  let changed = false;
  if (process.env.CREATED && process.env.SIDE_MODE === "side") config.stateDir = process.env.STATE_DIR;
  if (!config.agentCommand || config.agentCommand[0] === "omp") {
    const rest = Array.isArray(config.agentCommand) ? config.agentCommand.slice(1) : ["--dori-role", "lane", "--model", "{model}", "{prompt}"];
    config.agentCommand = [join(realpathSync(dirname(path)), "bin/omp"), ...rest];
    changed = true;
  }
  // OMP loads this source dependency as an extension, so the Dori extension must not import it again.
  if (config.ompUlwPath !== "") {
    config.ompUlwPath = "";
    changed = true;
  }
  if (changed) await Bun.write(path, JSON.stringify(config, null, 2) + "\n");'
printf '%s\n' "$mode" > "$base/.omp-dori"

command -v herdr >/dev/null || command -v hc >/dev/null || echo "Install herdr or hc before launching sessions." >&2

bun_bin="$(absolute "$(command -v bun)")"
ulw_guard() {
  [ -n "$ulw_bound" ] || return 0
  printf '%s\n' 'guard=$(mktemp -d)' 'trap '\''rmdir "$guard"'\'' EXIT'
  printf '(cd "$guard" && %q %q assert-ulw %q %q %q)\n' "$bun_bin" "$src/scripts/source-dependencies.ts" "$src" "$HOME" "$ulw"
  printf '%s\n' 'rmdir "$guard"' 'trap - EXIT'
}
if [ "$mode" = primary ]; then
  mkdir -p "$base/bin"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    ulw_guard
    printf 'exec %q "$@"\n' "$omp_bin"
  } > "$base/bin/omp"
  chmod 755 "$base/bin/omp"
fi
if [ "$mode" = primary ]; then
  cat <<EOF
Installed.
  Skill:     $skills/dori-mode
  Extension: $extensions/omp-dori
  omp-ulw:   $ulw_extension (OMP extension; active in every globally discovering OMP session)
  CLI:       dori (messenger/lane CLI), dori harness (upstream harness)
  Config:    $config
Next: configure the runtime and hooks, install the omp herdr integration if using herdr,
then start $base/bin/omp --dori-role dori. Installation does not start a messenger or watcher.
EOF
  exit 0
fi

hc_session="${OMP_DORI_HC_SESSION:-omp-dori}"
skill="$base/skills/omp-dori-mode"
mkdir -p "$base/bin" "$base/state" "$base/skills"
rm -rf "$skill"
mkdir -p "$skill"
# omp lists one of two skills with the same description, so the copy changes its description as well as its name.
awk 'NR == 1 { print; next }
  !done && /^name: dori-mode$/ { print "name: omp-dori-mode"; next }
  !done && /^description: / { sub(/^description: /, "description: For the omp-dori installation next to another Dori (omp-dori command). "); print; next }
  !done && /^---$/ { done = 1 }
  { print }' "$src/skills/dori-mode/SKILL.md" > "$skill/SKILL.md"
for part in references scripts assets; do
  [ -e "$src/skills/dori-mode/$part" ] && ln -sfn "$src/skills/dori-mode/$part" "$skill/$part"
done
quoted_skills="$(bun -e 'console.log(JSON.stringify(process.argv[1]))' "$base/skills")"
cat > "$base/omp.yml" <<EOF
# Generated by scripts/install-source.sh for omp-dori omp sessions; rewritten on each install.
skills:
  ignoredSkills:
    - dori-mode
  customDirectories:
    - $quoted_skills
EOF
{
  printf 'export DORI_HOME=%q\n' "$base"
  printf 'export DORI_CONFIG=%q\n' "$config"
  printf 'export DORI_STATE_DIR=%q\n' "$base/state"
  printf '%s\n' 'unset DORI_AGENT_CMD DORI_AGENT_EXECUTABLE DORI_OMP_ULW_PATH'
  printf 'export DORI_AGENT_ARGV=%q\n' "$(bun -e 'console.log(JSON.stringify([process.argv[1]]))' "$base/bin/omp")"
  printf 'export HC_SESSION=%q\n' "$hc_session"
  # A Herdr app space id shows the side Dori's terminals in that space; without one, hc keeps them hidden.
  [ -z "${OMP_DORI_HC_SPACE:-}" ] || printf 'export DORI_HC_SPACE=%q\n' "$OMP_DORI_HC_SPACE"
  printf 'case ":$PATH:" in *:%q:*) ;; *) export PATH=%q:"$PATH" ;; esac\n' "$base/bin" "$base/bin"
} > "$base/env.sh"
wrapper() {
  { printf '#!/usr/bin/env bash\nset -euo pipefail\n. %q\n' "$base/env.sh"; cat; } > "$base/bin/$1"
  chmod 755 "$base/bin/$1"
}
printf 'exec %q %q "$@"\n' "$bun_bin" "$src/skills/dori-mode/scripts/src/cli.ts" | wrapper dori
{ ulw_guard; printf 'exec %q --no-extensions -e %q -e %q --config %q "$@"\n' "$omp_bin" "$src/extension" "$ulw" "$base/omp.yml"; } | wrapper omp
printf 'case "${1:-}" in\n  omp) shift; exec %q "$@" ;;\n  hc) shift; exec hc "$@" ;;\n  *) exec %q "$@" ;;\nesac\n' \
  "$base/bin/omp" "$base/bin/dori" | wrapper omp-dori
mkdir -p "$bin_dir"
link "$base/bin/omp-dori" "$bin_dir/omp-dori" || echo "Run $base/bin/omp-dori directly." >&2

cat <<EOF
Installed next to the Dori in $primary_home, which was not changed.
  Home:       $base (config.json, state, generated skill, omp.yml and wrappers)
  Command:    $bin_dir/omp-dori  (omp-dori <dori command> | omp-dori omp ... | omp-dori hc ...)
  Skill:      omp-dori-mode; dori-mode is hidden in omp-dori omp sessions
  Extensions: $src/extension and $ulw, loaded only by omp-dori omp, which discovers no other OMP extension
  omp-ulw:    $ulw
  hc session: $hc_session
  Config:     $config
Next: create a separate messenger bot and channel, set runtime, leadPane, defaultCwd, defaultModel and hooks
in $config, then start the lead in its own hc session:
  omp-dori hc run --name omp-dori-lead${OMP_DORI_HC_SPACE:+ --label herdr.space=$OMP_DORI_HC_SPACE} -- omp-dori omp --dori-role dori
Installation does not start a messenger, watcher or hc server.
EOF

#!/usr/bin/env bash
# Installs an OMP Dori source checkout: skill CLI, harness sources, extension, and source-selected omp-ulw.
# DORI_NO_PULL=1 (or true, yes) installs an existing checkout without updating it.
# DORI_INSTALL_MODE=primary installs into ~/.dori; DORI_INSTALL_MODE=side installs next to another Dori, in
# OMP_DORI_HOME (default ~/.omp-dori), without changing ~/.dori, the dori command or the dori-mode skill.
# Without DORI_INSTALL_MODE, a ~/.dori owned by another Dori is never changed: a terminal is asked, anything else stops.
# Consumer-managed ~/.dori homes use dori update; primary source installation always holds there.
# Source omp-ulw follows OMP_ULW_REF (default main; lock uses omp-ulw.lock), or reuses an existing checkout.
# Primary mode discovers it globally; side mode loads it only through the isolated omp-dori omp wrapper.
# Optional paths: DORI_SRC, OMP_ULW_SRC, OMP_ULW_REPO, SKILLS_DIR, OMP_EXTENSIONS_DIR, OMP_DORI_HOME, OMP_DORI_BIN_DIR.
set -euo pipefail

fail() { echo "$1" >&2; exit 1; }
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
at_least() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | { read -r first; printf '%s\n' "$first"; })" = "$1" ]; }

repo="https://github.com/vntrevx/omp-dori.git"
ulw_repo="${OMP_ULW_REPO:-https://github.com/dbc-hbin/omp-ulw.git}"
ulw_ref="${OMP_ULW_REF:-main}"
primary_home="$HOME/.dori"
side_home="$(absolute "${OMP_DORI_HOME:-$HOME/.omp-dori}")"
min_bun="1.4.4"
min_omp="18.18.8"

command -v git >/dev/null || fail "git is required"
command -v bun >/dev/null || fail "bun $min_bun+ is required: https://bun.sh"
command -v omp >/dev/null || fail "omp $min_omp+ is required"
bun_version="$(bun --version)"
at_least "$min_bun" "$bun_version" || fail "bun $bun_version is older than $min_bun"
omp_version="$(omp --version)"
[[ "$omp_version" =~ ([0-9]+(\.[0-9]+){2}) ]] || fail "could not read omp version: $omp_version"
omp_version="${BASH_REMATCH[1]}"
at_least "$min_omp" "$omp_version" || fail "omp $omp_version is older than $min_omp"
ulw_main_omp="18.19.0"
if [ -z "${OMP_ULW_REF:-}" ] && ! at_least "$ulw_main_omp" "$omp_version"; then
  ulw_ref=lock
  echo "omp-ulw: its main needs OMP $ulw_main_omp+, this OMP is $omp_version, so omp-ulw.lock is used; update OMP or set OMP_ULW_REF to choose." >&2
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
  [ -d "$primary_home/src/.git" ] && is_omp_dori "$primary_home/src" && return 1
  [ -f "$primary_home/config.json" ] && return 0
  [ -d "$primary_home/src/.git" ] && return 0
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
    if marked "$base" && [ "$entry" = "$extensions/omp-ulw" ] &&
      [ "$(readlink "$entry" 2>/dev/null)" = "$base/omp-ulw" ]; then continue; fi
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

if [ -z "${DORI_SRC:-}" ] && [ -d "$src/.git" ] && ! is_omp_dori "$src"; then
  fail "$src is a checkout of $(git -C "$src" remote get-url origin 2>/dev/null || echo 'another repository'), not omp-dori; nothing was changed. Move it aside, set DORI_SRC, or install with DORI_INSTALL_MODE=side."
fi

if [ ! -d "$src/.git" ]; then
  git clone --quiet --depth 1 "$repo" "$src"
elif [[ "${DORI_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "DORI_NO_PULL=$DORI_NO_PULL: installing $src as it is, without pulling" >&2
elif ! git -C "$src" fetch --quiet; then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
elif ! git -C "$src" merge --ff-only --quiet '@{u}'; then
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

if [ -n "$standalone_ulw" ]; then
  echo "omp-ulw: using the standalone extension at $standalone_ulw; omp-dori does not load a second copy." >&2
  if marked "$base" && [ "$(readlink "$extensions/omp-ulw" 2>/dev/null)" = "$base/omp-ulw" ]; then
    rm "$extensions/omp-ulw"
    echo "omp-ulw: removed the earlier $extensions/omp-ulw link so omp-ulw loads once." >&2
  fi
elif [ -z "$ulw_explicit" ]; then
  [ -d "$ulw/.git" ] || git clone --quiet "$ulw_repo" "$ulw"
  if [ -n "${OMP_ULW_REPO:-}" ]; then git -C "$ulw" remote set-url origin "$ulw_repo"; fi
  git -C "$ulw" fetch --quiet origin
  if [ "$ulw_ref" = lock ]; then
    target="$(tr -d '[:space:]' < "$src/omp-ulw.lock")"
  elif git -C "$ulw" rev-parse --verify --quiet "origin/$ulw_ref^{commit}" >/dev/null; then
    target="origin/$ulw_ref"
  else
    target="$ulw_ref"
  fi
  git -C "$ulw" -c advice.detachedHead=false checkout --quiet "$target"
  is_ulw "$ulw" || fail "$ulw is not an omp-ulw checkout (no index.ts and presets.ts)"
  echo "omp-ulw: $ulw_ref at $(git -C "$ulw" rev-parse --short HEAD)" >&2
  if [ -f "$ulw/upstream/materialize-frontend-refs.mjs" ]; then
    { git -C "$ulw" submodule update --init --recursive --quiet && (cd "$ulw" && bun upstream/materialize-frontend-refs.mjs >/dev/null); } ||
      echo "omp-ulw: frontend references were not generated; see $ulw/README.md" >&2
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
side_omp=""
[ "$mode" = side ] && side_omp="$base/bin/omp"
CONFIG="$config" CREATED="$created" SIDE_OMP="$side_omp" STATE_DIR="$base/state" bun -e '
  const path = process.env.CONFIG;
  const config = await Bun.file(path).json();
  let changed = false;
  if (process.env.CREATED && process.env.SIDE_OMP) {
    // A new side configuration keeps its state and lanes inside the side home, never in ~/.dori.
    const rest = Array.isArray(config.agentCommand) ? config.agentCommand.slice(1) : ["--dori-role", "lane", "--model", "{model}", "{prompt}"];
    config.stateDir = process.env.STATE_DIR;
    config.agentCommand = [process.env.SIDE_OMP, ...rest];
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

if [ "$mode" = primary ]; then
  cat <<EOF
Installed.
  Skill:     $skills/dori-mode
  Extension: $extensions/omp-dori
  omp-ulw:   $ulw_extension (OMP extension; active in every globally discovering OMP session)
  CLI:       dori (messenger/lane CLI), dori harness (upstream harness)
  Config:    $config
Next: configure the runtime and hooks, install the omp herdr integration if using herdr,
then start omp --dori-role dori. Installation does not start a messenger or watcher.
EOF
  exit 0
fi

real_omp() {
  local dir
  local IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] && [ "$dir" != "$base/bin" ] && [ -f "$dir/omp" ] && [ -x "$dir/omp" ] && { printf '%s\n' "$dir/omp"; return 0; }
  done
  fail "omp is not on PATH"
}
hc_session="${OMP_DORI_HC_SESSION:-omp-dori}"
omp_bin="$(real_omp)"
bun_bin="$(command -v bun)"
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
  printf 'export DORI_AGENT_CMD=%q\n' "$base/bin/omp"
  printf 'export HC_SESSION=%q\n' "$hc_session"
  printf 'case ":$PATH:" in *:%q:*) ;; *) export PATH=%q:"$PATH" ;; esac\n' "$base/bin" "$base/bin"
} > "$base/env.sh"
wrapper() {
  { printf '#!/usr/bin/env bash\n. %q\n' "$base/env.sh"; cat; } > "$base/bin/$1"
  chmod 755 "$base/bin/$1"
}
printf 'exec %q %q "$@"\n' "$bun_bin" "$src/skills/dori-mode/scripts/src/cli.ts" | wrapper dori
printf 'exec %q --no-extensions -e %q -e %q --config %q "$@"\n' "$omp_bin" "$src/extension" "$ulw" "$base/omp.yml" | wrapper omp
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
  omp-dori hc run --name omp-dori-lead -- omp-dori omp --dori-role dori
Installation does not start a messenger, watcher or hc server.
EOF

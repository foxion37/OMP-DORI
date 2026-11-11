#!/usr/bin/env bash
# Installs omp-dori: the dori-mode skill, the `dori` CLI, the omp-dori omp extension and its pinned omp-ulw.
# Usage: curl -fsSL https://raw.githubusercontent.com/foxion37/OMP-DORI/main/install.sh | bash
# Re-run to update. Needs: git, bun 1.3+, omp 18.14.2+.
# Optional env: DORI_SRC (clone dir), OMP_ULW_SRC (your own omp-ulw checkout; left as is),
#               SKILLS_DIR (where omp loads skills), OMP_EXTENSIONS_DIR (omp global extensions).
set -euo pipefail

fail() { echo "$1" >&2; exit 1; }
# Paths end up in symlinks and in config.json, so a relative env value is anchored at the directory the installer ran in.
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
# at_least <minimum> <version>: version sorts at or after minimum.
at_least() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }

repo="https://github.com/foxion37/OMP-DORI.git"
ulw_repo="https://github.com/dbc-hbin/omp-ulw.git"
src="$(absolute "${DORI_SRC:-$HOME/.dori/src}")"
ulw="$(absolute "${OMP_ULW_SRC:-$HOME/.dori/omp-ulw}")"
skills="$(absolute "${SKILLS_DIR:-$HOME/.agents/skills}")"
extensions="$(absolute "${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}")"
min_bun="1.3.0"
min_omp="18.14.2"

command -v git >/dev/null || fail "git is required"
command -v bun >/dev/null || fail "bun $min_bun+ is required: https://bun.sh"
command -v omp >/dev/null || fail "omp is required: bun install -g @oh-my-pi/pi-coding-agent"

bun_version="$(bun --version)"
at_least "$min_bun" "$bun_version" || fail "bun $bun_version is older than $min_bun. Update: bun upgrade"
omp_version="$(omp --version | sed -E 's/^[^0-9]*//')"
at_least "$min_omp" "$omp_version" || fail "omp $omp_version is older than $min_omp (omp-ulw's baseline). Update: bun install -g @oh-my-pi/pi-coding-agent@latest"

if [ -d "$src/.git" ]; then git -C "$src" pull --ff-only --quiet; else git clone --quiet "$repo" "$src"; fi

if [ -n "${OMP_ULW_SRC:-}" ]; then
  [ -f "$ulw/index.ts" ] || fail "OMP_ULW_SRC=$ulw has no index.ts"
else
  pin="$(tr -d '[:space:]' < "$src/omp-ulw.lock")"
  [ -d "$ulw/.git" ] || git clone --quiet "$ulw_repo" "$ulw"
  git -C "$ulw" fetch --quiet origin
  git -C "$ulw" -c advice.detachedHead=false checkout --quiet "$pin"
fi

link() { # link <target> <path>: never replaces something that is not a link
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "$2 exists and is not a link; leaving it alone" >&2
    return 1
  fi
  ln -sfn "$1" "$2"
}

mkdir -p "$skills" "$extensions"
link "$src/skills/dori-mode" "$skills/dori-mode" || true
link "$src/extension" "$extensions/omp-dori" || fail "cannot install the omp-dori extension at $extensions/omp-dori"

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)

mkdir -p "$HOME/.dori"
config="$HOME/.dori/config.json"
[ -f "$config" ] || cp "$src/skills/dori-mode/references/config.example.json" "$config"
# An explicit OMP_ULW_SRC always wins; otherwise only an unset or example value is filled in.
CONFIG="$config" ULW_INDEX="$ulw/index.ts" ULW_EXPLICIT="${OMP_ULW_SRC:+1}" bun -e '
  const path = process.env.CONFIG, index = process.env.ULW_INDEX;
  const config = await Bun.file(path).json();
  if (process.env.ULW_EXPLICIT || !config.ompUlwPath || config.ompUlwPath === "~/.dori/omp-ulw/index.ts") {
    config.ompUlwPath = index;
    await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
  }'

command -v herdr >/dev/null || echo "herdr is not installed yet: curl -fsSL https://herdr.dev/install.sh | sh" >&2

cat <<EOF
Installed.
  Skill:     $skills/dori-mode
  Extension: $extensions/omp-dori (inactive in sessions without --dori-role)
  omp-ulw:   $ulw
  CLI:       dori
  Config:    $config
Next:
  1. herdr integration install omp
  2. edit $config (leadPane, laneWorkspace, defaultCwd, hooks)
  3. in a herdr pane: omp --dori-role dori
  4. tell it: Dori mode
EOF

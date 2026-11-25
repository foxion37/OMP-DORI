import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An earlier omp-dori config: the removed runtime, panes, ULW overlay and launch prefix, and omp-dori names. */
export const OLD_CONFIG = {
  defaultModel: "old/model",
  runtime: "herdr",
  leadPane: "herdr:1",
  ompUlwPath: "~/.dori/omp-ulw/index.ts",
  launchKeywords: "ulw set goal and work",
  agentCommand: ["~/.dori/bin/omp", "--dori-role", "lane", "{prompt}"],
  hooks: { up: "exec ~/.dori/bin/dori up" },
  stateDir: "~/.dori/state",
  sessionsDir: "~/.dori/sessions",
};

/** A Cataly or omp-dori source tree: its skill CLI and its source-bundle lock. */
export function tree(home: string): string {
  const root = join(home, "tree");
  for (const dir of ["skills/dori-mode/scripts/src", "skills/cataly-mode/scripts/src", "src", "extension"])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "skills/dori-mode/scripts/src/cli.ts"), "export {};\n");
  writeFileSync(join(root, "skills/cataly-mode/scripts/src/cli.ts"), "export {};\n");
  writeFileSync(join(root, "src/cli.ts"), "export {};\n");
  writeFileSync(join(root, "omp-ulw.lock"), "{}\n");
  return root;
}

/** A complete earlier primary home: marker, config, tokens, owner profile, generated command and state. */
export function oldPrimary(home: string, config: unknown = OLD_CONFIG): string {
  const dir = join(home, ".dori");
  for (const part of ["bin", "state", "owner-history"]) mkdirSync(join(dir, part), { recursive: true });
  writeFileSync(join(dir, ".omp-dori"), "primary\n", { mode: 0o600 });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "discord-token"), "old-discord\n", { mode: 0o600 });
  writeFileSync(join(dir, "owner.md"), "# Owner\n", { mode: 0o600 });
  writeFileSync(join(dir, "owner-history/2026-01-01.md"), "# Snapshot\n", { mode: 0o600 });
  writeFileSync(join(dir, "bin/dori"), '#!/usr/bin/env bash\nset -euo pipefail\nexec /old/.dori/bin/cataly "$@"\n', {
    mode: 0o755,
  });
  return dir;
}

/** The links and caches earlier installs made outside their home, all pointing at `root` or an earlier home. */
export function leftovers(home: string, root: string): void {
  const link = (dir: string, name: string, to: string) => {
    mkdirSync(dir, { recursive: true });
    symlinkSync(to, join(dir, name));
  };
  link(join(home, "extensions"), "omp-dori", join(root, "extension"));
  link(join(home, "extensions"), "omp-ulw", join(home, ".dori/omp-ulw"));
  link(join(home, "skills"), "dori-mode", join(root, "skills/dori-mode"));
  link(join(home, "global-bin"), "dori", join(root, "skills/dori-mode/scripts/src/cli.ts"));
  link(join(home, "global-bin"), "dori-harness", join(root, "src/cli.ts"));
  link(join(home, "global-bin"), "omp-dori", join(home, ".omp-dori/bin/omp-dori"));
  link(join(home, ".bun/install/global/node_modules"), "dori-mode-scripts", join(root, "skills/dori-mode/scripts"));
  link(join(home, ".bun/install/global/node_modules"), "dori-superagent", root);
  mkdirSync(join(home, ".cache/omp-dori/native-linux-x64-old"), { recursive: true });
  mkdirSync(join(home, ".cache/omp-cataly", `omp-ulw-${"a".repeat(64)}`), { recursive: true });
}

/** A same-named link or directory that no earlier Cataly or omp-dori install made. */
export function foreignLeftovers(home: string): void {
  const mine = join(home, "mine");
  mkdirSync(mine, { recursive: true });
  for (const name of ["dori", "omp-dori", "skill"])
    writeFileSync(join(mine, name), "the owner's own\n", { mode: 0o600 });
  const link = (dir: string, name: string, to: string) => {
    mkdirSync(dir, { recursive: true });
    symlinkSync(to, join(dir, name));
  };
  link(join(home, "extensions"), "omp-dori", join(mine, "skill"));
  link(join(home, "skills"), "dori-mode", join(mine, "skill"));
  link(join(home, "global-bin"), "dori", join(mine, "dori"));
  link(join(home, "global-bin"), "omp-dori", join(mine, "omp-dori"));
  // The name alone is never evidence: no marker, no receipt, no checkout of ours.
  mkdirSync(join(home, ".dori/notes"), { recursive: true });
  writeFileSync(join(home, ".dori/config.json"), "{}\n", { mode: 0o600 });
}

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type ConsumerPaths, isPrimaryConsumer, owned, realDirectory, syncDirectory } from "./files.ts";

const parts = ["references", "scripts", "assets"] as const;

export function prepareConsumerDiscovery(paths: ConsumerPaths, source: string): void {
  if (isPrimaryConsumer(paths)) return;
  // The retained target release always renders its own discovery overlay, including after rollback.
  const isolatedName = "omp-cataly-mode";
  const sourceSkill = join(source, "skills/cataly-mode");
  const parent = join(paths.root, "consumer-discovery");
  const destination = join(parent, basename(source));
  const skill = readFileSync(join(sourceSkill, "SKILL.md"), "utf8")
    .replace(/^name: cataly-mode$/m, `name: ${isolatedName}`)
    .replace(/^description: /m, "description: For this isolated Cataly consumer installation. ");
  const overlay = `skills:\n  customDirectories:\n    - ${JSON.stringify(join(destination, "skills"))}\n`;
  realDirectory(parent, true);
  owned(parent);

  const validate = (): void => {
    for (const [path, names] of [
      [destination, ["docs", "omp.yml", "skills"]],
      [join(destination, "skills"), [isolatedName]],
      [join(destination, "skills", isolatedName), ["SKILL.md", ...parts]],
    ] as const) {
      realDirectory(path);
      owned(path);
      const stat = lstatSync(path);
      if ((stat.mode & 0o7777) !== 0o700 || readdirSync(path).sort().join("\0") !== [...names].sort().join("\0"))
        throw new Error(`Modified consumer discovery directory: ${path}`);
    }
    for (const [path, bytes] of [
      [join(destination, "omp.yml"), overlay],
      [join(destination, "skills", isolatedName, "SKILL.md"), skill],
    ] as const) {
      const stat = lstatSync(path);
      owned(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o7777) !== 0o600 ||
        readFileSync(path, "utf8") !== bytes
      )
        throw new Error(`Modified consumer discovery file: ${path}`);
    }
    for (const part of parts) {
      const path = join(destination, "skills", isolatedName, part);
      const stat = lstatSync(path);
      owned(path);
      if (!stat.isSymbolicLink() || readlinkSync(path) !== join(sourceSkill, part))
        throw new Error(`Modified consumer discovery link: ${path}`);
    }
    const docs = join(destination, "docs");
    const stat = lstatSync(docs);
    owned(docs);
    if (!stat.isSymbolicLink() || readlinkSync(docs) !== join(source, "docs"))
      throw new Error(`Modified consumer discovery link: ${docs}`);
  };

  if (lstatSync(destination, { throwIfNoEntry: false })) {
    validate();
    return;
  }
  const stage = mkdtempSync(join(paths.staging, "discovery-"));
  try {
    const skills = join(stage, "skills");
    const skillDir = join(skills, isolatedName);
    mkdirSync(skills, { mode: 0o700 });
    mkdirSync(skillDir, { mode: 0o700 });
    for (const [path, bytes] of [
      [join(stage, "omp.yml"), overlay],
      [join(skillDir, "SKILL.md"), skill],
    ] as const) {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        chmodSync(path, 0o600);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    for (const part of parts) symlinkSync(join(sourceSkill, part), join(skillDir, part));
    symlinkSync(join(source, "docs"), join(stage, "docs"));
    syncDirectory(skillDir);
    syncDirectory(skills);
    syncDirectory(stage);
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      validate();
    } else {
      renameSync(stage, destination);
      syncDirectory(parent);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

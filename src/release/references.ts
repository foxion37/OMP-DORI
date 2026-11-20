import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { prepareConsumerDiscovery } from "./discovery.ts";
import { nativeOmp } from "./provision.ts";
import { type ConsumerPaths, owned, readJson, realDirectory, regularFile, saveJson, syncDirectory } from "./files.ts";

const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const isolated = (paths: ConsumerPaths): boolean => paths.dori !== join(paths.home, ".dori");
type Reference = { readonly bytes: string; readonly executable: boolean };
const FILES = ["bin/dori", "bin/dori-harness", "bin/omp", "bin/omp-dori", "omp.yml"] as const;
type PendingReferences = {
  readonly before: Readonly<Record<string, string>>;
  readonly references: Readonly<Record<string, Reference>>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function pendingReferences(paths: ConsumerPaths): PendingReferences | undefined {
  const path = join(paths.root, "consumer-references-pending.json");
  if (!regularFile(path)) return undefined;
  const raw = readJson(path);
  if (
    !object(raw) ||
    Object.keys(raw).sort().join() !== "before,references" ||
    !object(raw["before"]) ||
    !object(raw["references"])
  )
    throw new Error("Invalid pending consumer references");
  const before: Record<string, string> = {};
  const references: Record<string, Reference> = {};
  for (const [name, digest] of Object.entries(raw["before"])) {
    if (!FILES.some((file) => file === name) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid pending reference identity");
    before[name] = digest;
  }
  for (const [name, ref] of Object.entries(raw["references"])) {
    if (
      !FILES.some((file) => file === name) ||
      !object(ref) ||
      Object.keys(ref).sort().join() !== "bytes,executable" ||
      typeof ref["bytes"] !== "string" ||
      ref["executable"] !== name.startsWith("bin/")
    )
      throw new Error("Invalid pending reference content");
    references[name] = { bytes: ref["bytes"], executable: name.startsWith("bin/") };
  }
  if ([...new Set([...Object.keys(before), ...Object.keys(references)])].sort().join() !== [...FILES].sort().join())
    throw new Error("Incomplete pending consumer references");
  return { before, references };
}

/** Generated references belong to the consumer, never to an existing source installer or its wrappers. */
export function preflightReferences(paths: ConsumerPaths): void {
  if (!isolated(paths)) return;
  const receipt = join(paths.root, "consumer-references.json");
  const pending = pendingReferences(paths);
  if (!regularFile(receipt) && !pending) {
    for (const path of FILES) {
      if (lstatSync(join(paths.dori, path), { throwIfNoEntry: false }))
        throw new Error(`Unmanaged installation reference: ${join(paths.dori, path)}`);
    }
  } else {
    const recorded = regularFile(receipt) ? readJson(receipt) : {};
    const expected = {
      ...pending?.before,
      ...Object.fromEntries(Object.entries(pending?.references ?? {}).map(([path, ref]) => [path, hash(ref.bytes)])),
    };
    if (
      !object(recorded) ||
      (!pending && Object.keys(recorded).sort().join() !== [...FILES].sort().join()) ||
      (pending &&
        JSON.stringify(recorded) !== JSON.stringify(pending.before) &&
        JSON.stringify(recorded) !== JSON.stringify(expected))
    )
      throw new Error("Invalid consumer reference receipt");
    for (const path of FILES) {
      const destination = join(paths.dori, path);
      const present = regularFile(destination);
      const allowed = pending ? [pending.before[path], expected[path]] : [recorded[path]];
      if (
        (!present && !allowed.includes(undefined)) ||
        (present &&
          (!allowed.includes(hash(readFileSync(destination, "utf8"))) ||
            (lstatSync(destination).mode & 0o111) !== (path.startsWith("bin/") ? 0o111 : 0)))
      )
        throw new Error(`Consumer reference changed: ${path}; preserve it before reinstalling`);
    }
  }
  for (const path of FILES) realDirectory(dirname(join(paths.dori, path)));
}

function finishReferences(paths: ConsumerPaths, pending: PendingReferences): void {
  const digests = { ...pending.before };
  for (const [path, ref] of Object.entries(pending.references)) {
    const destination = join(paths.dori, path);
    realDirectory(dirname(destination), true);
    owned(dirname(destination));
    const temporary = `${destination}.consumer-${randomUUID()}`;
    writeFileSync(temporary, ref.bytes, { flag: "wx", mode: ref.executable ? 0o755 : 0o600 });
    chmodSync(temporary, ref.executable ? 0o755 : 0o600);
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
    digests[path] = hash(ref.bytes);
  }
  saveJson(join(paths.root, "consumer-references.json"), digests);
  unlinkSync(join(paths.root, "consumer-references-pending.json"));
  syncDirectory(paths.root);
}

export function installIsolatedReferences(paths: ConsumerPaths, source: string): void {
  if (!isolated(paths)) return;
  preflightReferences(paths);
  prepareConsumerDiscovery(paths, source);
  const interrupted = pendingReferences(paths);
  if (interrupted) finishReferences(paths, interrupted);
  const receipt = join(paths.root, "consumer-references.json");
  const references: Record<string, Reference> = {};
  const omp = nativeOmp();
  if (!omp && !regularFile(join(source, "native-omp.lock")))
    throw new Error("The native omp command is unavailable outside Dori wrappers");
  const protocol =
    'const {readFileSync}=require("node:fs"); const {requirements,source}=JSON.parse(readFileSync(process.argv[1],"utf8")); const bound=source.files.some(({path})=>["native-omp.lock","native-omp.patch","omp-ulw.overlay.lock","omp-ulw.patch"].includes(path)); if(requirements.omp!==(bound?"18.20.0":"18.18.8")) throw new Error("Unsupported or inconsistent consumer native protocol"); console.log(requirements.omp);';
  const legacy = omp
    ? `omp=${quote(omp)}`
    : 'echo "An independent native OMP is required for this retained release; reinstall with its toolchain" >&2; exit 1';
  const env = [
    `export DORI_HOME=${quote(paths.dori)}`,
    `export DORI_CONFIG=${quote(paths.config)}`,
    `export DORI_AGENT_CMD=${quote(join(paths.dori, "bin/omp"))}`,
    `export DORI_CMD=${quote(quote(join(paths.dori, "bin/dori-harness")))}`,
    "unset DORI_STATE_DIR DORI_LEAD_PANE DORI_RUNTIME DORI_HC_SPACE DORI_PROMPTS_DIR DORI_AGENT_ARGV DORI_OMP_ULW_PATH DORI_MANAGED_STARTUP",
    `if [ "\${HC_SESSION:-}" != ${quote(`omp-dori-${hash(paths.dori).slice(0, 12)}`)} ]; then unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SOCKET; fi`,
    `export HC_SESSION=${quote(`omp-dori-${hash(paths.dori).slice(0, 12)}`)}`,
    `if [ "\${DORI_HERDR_SESSION:-}" != ${quote(`omp-dori-${hash(paths.dori).slice(0, 12)}`)} ]; then unset HERDR_PANE_ID HERDR_WORKSPACE_ID; fi`,
    `export DORI_HERDR_SESSION=${quote(`omp-dori-${hash(paths.dori).slice(0, 12)}`)}`,
    `export PATH=${quote(join(paths.dori, "bin"))}:"$PATH"`,
  ].join("\n");
  const wrapper = (body: string): Reference => ({
    bytes: `#!/usr/bin/env bash\n# OMP-Dori consumer wrapper\n${env}\n${body}\n`,
    executable: true,
  });
  references["bin/dori"] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "skills/dori-mode/scripts/src/cli.ts"))} "$@"`,
  );
  references["bin/dori-harness"] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "src/cli.ts"))} "$@"`,
  );
  references["bin/omp"] = wrapper(
    `source=$(cd ${quote(paths.live)} && pwd -P) || exit\nif [ -f "$source/src/release/automatic.ts" ]; then\n  source=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} "$source/src/release/automatic.ts" "$source" "$HOME" "$$" "$@") || exit\nfi\nprotocol=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} -e ${quote(protocol)} ${quote(paths.manifests)}/"\${source##*/}".json) || exit\ncase "$protocol" in\n  18.20.0) omp="$source/scripts/consumer/omp" ;;\n  18.18.8) ${legacy} ;;\nesac\nexec "$omp" --no-extensions -e "$source/extension" --config ${quote(join(paths.dori, "omp.yml"))} --config ${quote(join(paths.root, "consumer-discovery"))}/"\${source##*/}"/omp.yml "$@"`,
  );
  references["bin/omp-dori"] = wrapper(
    `case "\${1:-}" in\n  omp) shift; exec ${quote(join(paths.dori, "bin/omp"))} "$@" ;;\n  hc) shift; exec hc "$@" ;;\n  *) exec ${quote(join(paths.dori, "bin/dori"))} "$@" ;;\nesac`,
  );
  // OMP self-update replaces the first omp on PATH, which is bin/omp above; the replaced wrapper would drop the
  // extension and the live source selection. The managed deployment keeps the same per-process fence.
  references["omp.yml"] = {
    bytes: "skills:\n  ignoredSkills:\n    - dori-mode\nupdate:\n  auto: false\n",
    executable: false,
  };
  const recorded = regularFile(receipt) ? readJson(receipt) : {};
  if (!object(recorded)) throw new Error("Invalid consumer reference receipt");
  const before: Record<string, string> = {};
  for (const [path, digest] of Object.entries(recorded)) {
    if (typeof digest !== "string") throw new Error("Invalid consumer reference digest");
    before[path] = digest;
  }
  const pending = { before, references };
  saveJson(join(paths.root, "consumer-references-pending.json"), pending);
  finishReferences(paths, pending);
}

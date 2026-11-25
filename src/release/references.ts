import { randomUUID } from "node:crypto";
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
import {
  type ConsumerPaths,
  isPrimaryConsumer,
  owned,
  readOptionalJson,
  realDirectory,
  regularFile,
  saveJson,
  syncDirectory,
} from "./files.ts";
import {
  nextReferenceDigests,
  readReferenceReceipts,
  REFERENCE_FILES,
  referenceHash,
  type PendingReferences,
  type Reference,
  type ReferenceReceipts,
} from "./reference-receipts.ts";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Generated references belong to the consumer, never to an existing source installer or its wrappers. */
export function preflightReferences(paths: ConsumerPaths): void {
  if (!isPrimaryConsumer(paths)) assertReferenceFiles(paths);
}

function assertReferenceFiles(paths: ConsumerPaths): ReferenceReceipts | undefined {
  const receipts = readReferenceReceipts(paths.root, readOptionalJson);
  const pending = receipts?.pending;
  const expected = pending ? nextReferenceDigests(pending) : receipts?.recorded;
  for (const path of REFERENCE_FILES) {
    const destination = join(paths.cataly, path);
    if (!expected) {
      realDirectory(dirname(destination));
      if (lstatSync(destination, { throwIfNoEntry: false }))
        throw new Error(`Unmanaged installation reference: ${destination}`);
      continue;
    }
    const present = regularFile(destination);
    const allowed = pending ? [pending.before[path], expected[path]] : [expected[path]];
    if (
      (!present && !allowed.includes(undefined)) ||
      (present &&
        (!allowed.includes(referenceHash(readFileSync(destination, "utf8"))) ||
          (lstatSync(destination).mode & 0o111) !== (path.startsWith("bin/") ? 0o111 : 0)))
    )
      throw new Error(`Consumer reference changed: ${path}; preserve it before reinstalling`);
  }
  return receipts;
}

function finishReferences(paths: ConsumerPaths, pending: PendingReferences): Readonly<Record<string, string>> {
  for (const [path, ref] of Object.entries(pending.references)) {
    const destination = join(paths.cataly, path);
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
  }
  const digests = nextReferenceDigests(pending);
  saveJson(join(paths.root, "consumer-references.json"), digests);
  unlinkSync(join(paths.root, "consumer-references-pending.json"));
  syncDirectory(paths.root);
  return digests;
}

export function installIsolatedReferences(paths: ConsumerPaths, source: string): void {
  if (isPrimaryConsumer(paths)) return;
  const receipts = assertReferenceFiles(paths);
  prepareConsumerDiscovery(paths, source);
  const before = receipts?.pending ? finishReferences(paths, receipts.pending) : (receipts?.recorded ?? {});
  const references: Record<string, Reference> = {};
  const env = [
    `unset ${["STATE_DIR", "PROMPTS_DIR", "AGENT_ARGV", "MANAGED_STARTUP"].map((key) => `CATALY_${key}`).join(" ")}`,
    `export CATALY_HOME=${quote(paths.cataly)}`,
    `export CATALY_CONFIG=${quote(paths.config)}`,
    `export CATALY_AGENT_CMD=${quote(join(paths.cataly, "bin/omp"))}`,
    `export CATALY_CMD=${quote(quote(join(paths.cataly, "bin/cataly-harness")))}`,
    `export PATH=${quote(join(paths.cataly, "bin"))}:"$PATH"`,
  ].join("\n");
  const wrapper = (body: string): Reference => ({
    bytes: `#!/usr/bin/env bash\n# Cataly consumer wrapper\n${env}\n${body}\n`,
    executable: true,
  });
  references["bin/cataly"] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "skills/cataly-mode/scripts/src/cli.ts"))} "$@"`,
  );
  references["bin/cataly-harness"] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "src/cli.ts"))} "$@"`,
  );
  references["bin/omp"] = wrapper(
    `source=$(cd ${quote(paths.live)} && pwd -P) || exit\nsource=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} "$source/src/release/automatic.ts" "$source" "$HOME" "$$" "$@") || exit\nexec "$source/scripts/consumer/omp" --no-extensions -e "$source/extension" --config ${quote(join(paths.cataly, "omp.yml"))} --config ${quote(join(paths.root, "consumer-discovery"))}/"\${source##*/}"/omp.yml "$@"`,
  );
  references["bin/omp-cataly"] = wrapper(
    `case "\${1:-}" in\n  omp) shift; exec ${quote(join(paths.cataly, "bin/omp"))} "$@" ;;\n  *) exec ${quote(join(paths.cataly, "bin/cataly"))} "$@" ;;\nesac`,
  );
  // OMP self-update replaces the first omp on PATH, which is bin/omp above; the replaced wrapper would drop the
  // extension and the live source selection. The managed deployment keeps the same per-process fence.
  references["omp.yml"] = {
    bytes: "skills:\n  ignoredSkills:\n    - cataly-mode\nupdate:\n  auto: false\n",
    executable: false,
  };
  const pending = { before, references };
  saveJson(join(paths.root, "consumer-references-pending.json"), pending);
  finishReferences(paths, pending);
}

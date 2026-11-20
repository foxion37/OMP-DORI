import { constants } from "node:fs";
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { sessionFileStart } from "./session-id.ts";

const readonlyOpen = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

type BranchEntry = {
  readonly parent: string | null;
  readonly model?: { readonly role: string; readonly selector: string };
  readonly assistantModel?: string;
};

function branchEntry(entry: Record<string, unknown>): BranchEntry | undefined {
  const parent = entry["parentId"];
  if (parent !== null && typeof parent !== "string") return;
  if (entry["type"] === "model_change" && typeof entry["model"] === "string" && entry["model"]) {
    const role = entry["role"];
    return { parent, model: { role: typeof role === "string" ? role : "default", selector: entry["model"] } };
  }
  const message = entry["message"];
  if (
    entry["type"] === "message" &&
    record(message) &&
    message["role"] === "assistant" &&
    typeof message["provider"] === "string" &&
    typeof message["model"] === "string" &&
    message["model"] !== "<synthetic>"
  )
    return { parent, assistantModel: `${message["provider"]}/${message["model"]}` };
  return { parent };
}

/** Pinned OMP prefers the active branch's last model role; "fallback" never becomes the saved default. */
function savedModel(entries: ReadonlyMap<string, BranchEntry>, leaf: string | null): string | undefined {
  let role: string | undefined;
  let preferred: string | undefined;
  let defaultModel: string | undefined;
  let legacyModel: string | undefined;
  const seen = new Set<string>();
  for (let id = leaf; id !== null;) {
    const entry = entries.get(id);
    if (!entry || seen.has(id)) return;
    seen.add(id);
    if (entry.model) {
      role ??= entry.model.role;
      if (role !== "fallback" && entry.model.role === role) preferred ??= entry.model.selector;
      if (entry.model.role === "default") defaultModel ??= entry.model.selector;
    }
    legacyModel ??= entry.assistantModel;
    id = entry.parent;
  }
  const selector = preferred ?? defaultModel ?? legacyModel;
  return selector && /^[^/\s\p{Cc}]+\/[^\s\p{Cc}]+$/u.test(selector) ? selector : undefined;
}

async function transcriptHeader(handle: FileHandle) {
  const head = Buffer.alloc(32 * 1024);
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  let start = 0;
  while (start < bytesRead) {
    const end = head.subarray(start, bytesRead).indexOf(10);
    if (end === -1) return;
    const entry: unknown = JSON.parse(head.toString("utf8", start, start + end));
    if (!record(entry)) return;
    if (entry["type"] === "session") return entry;
    if (entry["type"] !== "title") return;
    start += end + 1;
  }
}

/** OMP can follow continuations or fork departed sessions even with an absolute resume filename. */
export async function exactDiscordLaneTranscript(
  path: string,
  target: { readonly root: string; readonly session: string; readonly cwd: string },
) {
  if (!isAbsolute(path) || /\p{Cc}/u.test(path) || sessionFileStart(basename(path))?.id !== target.session) return;
  const [file, root] = await Promise.all([realpath(path), realpath(target.root)]);
  const rel = relative(root, file);
  if (file !== path || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  const uid = process.getuid?.();
  const parent = await stat(dirname(root));
  // OMP sometimes writes group-writable files beneath its mode-0700 agent directory.
  const writeMask = parent.isDirectory() && parent.uid === uid && (parent.mode & 0o077) === 0 ? 0o002 : 0o022;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const info = await stat(dir);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & writeMask) !== 0) return;
    if (dir === root) break;
  }
  await using handle = await open(file, readonlyOpen);
  const info = await handle.stat();
  if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & writeMask) !== 0) return;
  const header = await transcriptHeader(handle);
  if (
    header?.["id"] !== target.session ||
    typeof header["cwd"] !== "string" ||
    !isAbsolute(header["cwd"]) ||
    (await realpath(header["cwd"])) !== target.cwd
  )
    return;
  // Only generated sibling headers can redirect OMP's resume target.
  for (const name of await readdir(dirname(file))) {
    if (name === basename(file) || !sessionFileStart(name)) continue;
    await using sibling = await open(join(dirname(file), name), readonlyOpen);
    const entry = await sibling.stat();
    if (!entry.isFile() || entry.uid !== uid || (entry.mode & writeMask) !== 0) return;
    const candidate = await transcriptHeader(sibling);
    if (!candidate || candidate["continuationOf"] === target.session) return;
  }
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const entries = new Map<string, BranchEntry>();
  let leaf: string | null = null;
  let lastSelfSelected: string | null = null;
  try {
    for await (const line of lines) {
      const entry: unknown = JSON.parse(line);
      if (!record(entry)) return;
      if (
        entry["type"] === "custom_message" &&
        entry["customType"] === "session-transfer" &&
        record(entry["details"]) &&
        entry["details"]["kind"] === "departed"
      )
        return;
      const id = entry["id"];
      if (typeof id !== "string" || entry["type"] === "session") continue;
      const parsed = branchEntry(entry);
      if (!parsed) continue;
      entries.set(id, parsed);
      const active = entry["activeLeafId"];
      leaf = active === null || typeof active === "string" ? active : id;
      if (leaf === id) lastSelfSelected = id;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  const model = savedModel(entries, leaf === null || entries.has(leaf) ? leaf : lastSelfSelected);
  return { file, model };
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { routeNativeHead } from "../skills/cataly-mode/scripts/src/messenger/native-routing.ts";
import { MONITOR_MESSAGE, PREVIOUS_MONITOR_MESSAGE } from "../skills/cataly-mode/scripts/src/session-compat.ts";

type Metadata = { readonly identity?: unknown; readonly fingerprint?: unknown };
type ReceiptFields = { readonly ompCatalyAdmission?: Metadata; readonly ompDoriAdmission?: Metadata };
const REJECTION = "omp-cataly:admission-rejected";
const candidate = (value: unknown) => {
  const entry = value as {
    type?: string;
    customType?: string;
    id?: unknown;
    details?: ReceiptFields;
    data?: ReceiptFields;
  } | null;
  if (!entry || typeof entry !== "object") return undefined;
  // The previous main's message kind counts too, read only, so a receipt it recorded still resolves.
  const accepted =
    entry.type === "custom_message" &&
    (entry.customType === MONITOR_MESSAGE || entry.customType === PREVIOUS_MONITOR_MESSAGE);
  const rejected = entry.type === "custom" && entry.customType === REJECTION;
  const fields = accepted ? entry.details : rejected ? entry.data : undefined;
  // Each main wrote its own metadata key; neither is read for the other's message kind.
  const data = entry.customType === PREVIOUS_MONITOR_MESSAGE ? fields?.ompDoriAdmission : fields?.ompCatalyAdmission;
  return data
    ? { ...data, receipt: entry.id, outcome: accepted ? ("accepted" as const) : ("rejected" as const) }
    : undefined;
};

/** Native entries are already resident; a miss avoids reparsing the whole file before each new dispatch. */
export const hasHeadReceipt = (entries: readonly unknown[], identity: string): boolean =>
  entries.some((entry) => candidate(entry)?.identity === identity);

/** A receipt must be present in the native transcript, not just in the agent's in-memory aside queue. */
export async function headReceipt(
  file: string,
  identity: string,
  fingerprint: string,
): Promise<{ outcome: "accepted" | "rejected"; receipt: string } | undefined> {
  const native = routeNativeHead({
    op: "reconcile",
    file,
    identity,
    fingerprint,
    check_disk: true,
    binding: "original",
    accepts: false,
  });
  if (native) {
    const decision = await native;
    return "receipt" in decision ? { outcome: decision.action, receipt: decision.receipt } : undefined;
  }
  const fileHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
      throw new Error("head receipt requires an owned regular native transcript");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = stat.size;
    let pieces: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    let terminated = false;
    const receipt = () => {
      if (!terminated || oversized) return undefined;
      const text = Buffer.concat(pieces).toString("utf8");
      if (!text.includes('"ompCatalyAdmission"') && !text.includes('"ompDoriAdmission"')) return undefined;
      const found = candidate(JSON.parse(text));
      if (found?.identity !== identity) return undefined;
      if (found.fingerprint !== fingerprint || typeof found.receipt !== "string" || !found.receipt)
        throw new Error("head admission identity conflict");
      return { outcome: found.outcome, receipt: found.receipt };
    };
    // Read backwards: the just-persisted receipt is near EOF. Large unrelated entries use bounded memory.
    while (position > 0) {
      const length = Math.min(buffer.length, position);
      position -= length;
      let received = 0;
      while (received < length) {
        const read = await fileHandle.read(buffer, received, length - received, position + received);
        if (read.bytesRead === 0) throw new Error("native transcript changed while checking admission");
        received += read.bytesRead;
      }
      let end = length;
      while (end > 0) {
        const lf = buffer.lastIndexOf(10, end - 1);
        const part = buffer.subarray(lf + 1, end);
        bytes += part.length;
        if (bytes > 1024 * 1024) {
          oversized = true;
          pieces = [];
        } else if (!oversized) pieces.unshift(Buffer.from(part));
        if (lf >= 0) {
          const found = receipt();
          if (found) return found;
          // The first LF ends the newest complete entry; anything after it was an unterminated tail.
          terminated = true;
          pieces = [];
          bytes = 0;
          oversized = false;
        }
        end = Math.max(lf, 0);
      }
    }
    return receipt();
  } finally {
    await fileHandle.close();
  }
}

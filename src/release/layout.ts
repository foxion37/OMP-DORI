import { join } from "node:path";
import { contains } from "../update/config.ts";
import { readReferenceReceipts } from "./reference-receipts.ts";

export const isPrimaryConsumer = ({ home, cataly }: { readonly home: string; readonly cataly: string }): boolean =>
  cataly === join(home, ".cataly");

/** A side home stays apart from the primary home and, once it has wrappers, belongs to this exact location. */
export function assertConsumerHome(home: string, location: string, read: (path: string) => unknown): void {
  const primary = join(home, ".cataly");
  if (location !== primary && (contains(primary, location) || contains(location, primary)))
    throw new Error(`A consumer home must not contain or be inside the primary home ${primary}`);
  if (location === primary) return;
  // A custom home may have committed its transaction before publishing any of its wrappers.
  const root = join(location, "releases");
  if (!readReferenceReceipts(root, read)) return;
  const owner = read(join(root, "consumer-owner.json"));
  if (JSON.stringify(owner) !== JSON.stringify({ version: 1, home, liveSource: join(location, "src") }))
    throw new Error("Consumer release ownership differs");
}

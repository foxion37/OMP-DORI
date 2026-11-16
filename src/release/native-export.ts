import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../update/source.ts";
import { owned, readJson, realDirectory, regularFile } from "./files.ts";

/** A fresh source checkout may precede generation; a native runtime must carry the exact bound viewer. */
export function assertNativeExport(checkout: string, required = true): boolean {
  const agent = join(checkout, "packages/coding-agent");
  const assets = join(agent, "export-assets");
  if (!lstatSync(assets, { throwIfNoEntry: false })) {
    if (required) throw new Error("Bound native export viewer is missing");
    return false;
  }
  realDirectory(assets);
  for (const path of [checkout, join(checkout, "packages"), agent, assets]) owned(path);
  for (const path of ["src", "src/export", "src/export/html"]) owned(join(agent, path));
  const manifest = readJson(join(agent, "src/export/html/viewer.generated.json")) as {
    file: string;
    integrity: string;
    size: number;
  };
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Object.keys(manifest).sort().join() !== "file,integrity,size" ||
    typeof manifest.file !== "string" ||
    !/^export-viewer-[a-f0-9]{64}\.js$/.test(manifest.file) ||
    typeof manifest.integrity !== "string" ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0
  )
    throw new Error("Bound native export viewer manifest is invalid");
  const entries = readdirSync(assets);
  if (entries.length !== 1 || entries[0] !== manifest.file)
    throw new Error("Bound native export assets differ from their manifest");
  const viewer = join(assets, manifest.file);
  if (!regularFile(viewer) || lstatSync(viewer).size !== manifest.size)
    throw new Error("Bound native export viewer size differs");
  const hash = digest(readFileSync(viewer));
  if (
    manifest.file !== `export-viewer-${hash}.js` ||
    manifest.integrity !== `sha256-${Buffer.from(hash, "hex").toString("base64")}`
  )
    throw new Error("Bound native export viewer digest differs");
  return true;
}

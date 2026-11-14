import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { hasControl } from "../update/config.ts";
import { assertSourceAdmission, digest, sameManifest, sourceManifest } from "../update/source.ts";
import type { ReleaseManifest } from "./types.ts";

export type ArchiveFile = { readonly path: string; readonly bytes: Buffer; readonly executable: boolean };
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_SOURCE = 512 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function text(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((byte) => byte !== 0)) throw new Error("Invalid tar text padding");
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Buffer): number {
  const value = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Oversized tar member");
  return number;
}

/** Parse and admit every member before creating any output path. No external tar process is trusted. */
export function readArchive(archive: Uint8Array, manifest: ReleaseManifest): readonly ArchiveFile[] {
  if (archive.byteLength !== manifest.archive.bytes || archive.byteLength > MAX_ARCHIVE)
    throw new Error("Release archive size differs");
  if (digest(archive) !== manifest.archive.sha256) throw new Error("Release archive SHA256 differs");
  const tar = gunzipSync(archive, { maxOutputLength: MAX_SOURCE });
  if (tar.length % 512 !== 0) throw new Error("Truncated tar archive");
  const allowedDirectories = new Set<string>([manifest.archive.root]);
  for (const file of manifest.source.files) {
    let dir = dirname(`${manifest.archive.root}/${file.path}`);
    while (dir !== ".") {
      allowedDirectories.add(dir);
      dir = dirname(dir);
    }
  }
  const expected = new Map(manifest.source.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const files: ArchiveFile[] = [];
  let end = false;
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0))
        throw new Error("Invalid tar end marker");
      end = true;
      break;
    }
    const checksum = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual || text(header.subarray(257, 263)) !== "ustar") throw new Error("Invalid USTAR header");
    const prefix = text(header.subarray(345, 500));
    let name = `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`;
    const kind = header[156];
    const directory = kind === 53;
    if (directory && name.endsWith("/")) name = name.slice(0, -1);
    if (
      !name ||
      hasControl(name, true) ||
      name.includes(" ") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      (name !== manifest.archive.root && !name.startsWith(`${manifest.archive.root}/`)) ||
      seen.has(name)
    )
      throw new Error(`Unsafe or duplicate tar path: ${name}`);
    seen.add(name);
    if ((kind !== 0 && kind !== 48 && !directory) || text(header.subarray(157, 257)) !== "")
      throw new Error(`Unsafe tar member type: ${name}`);
    const mode = octal(header.subarray(100, 108));
    if ((mode & ~0o777) !== 0) throw new Error(`Unsafe tar member mode: ${name}`);
    const size = octal(header.subarray(124, 136));
    offset += 512;
    if (size > MAX_SOURCE || offset + Math.ceil(size / 512) * 512 > tar.length) throw new Error("Truncated tar member");
    if (directory) {
      if (size !== 0 || !allowedDirectories.has(name)) throw new Error(`Unexpected tar directory: ${name}`);
    } else {
      const path = name.slice(manifest.archive.root.length + 1);
      const wanted = expected.get(path);
      const bytes = tar.subarray(offset, offset + size);
      const executable = (mode & 0o111) !== 0;
      if (!wanted || wanted.executable !== executable || digest(bytes) !== wanted.sha256)
        throw new Error(`Release source bytes/mode differ: ${path}`);
      files.push({ path, bytes, executable });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!end || files.length !== expected.size) throw new Error("Release archive omits manifest source");
  return files;
}

export function extractArchive(files: readonly ArchiveFile[], manifest: ReleaseManifest, destination: string): void {
  mkdirSync(destination, { mode: 0o700 });
  for (const file of files) {
    const path = join(destination, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    chmodSync(path, file.executable ? 0o755 : 0o644);
  }
  const actual = sourceManifest(destination);
  assertSourceAdmission(actual, "upstream");
  if (!sameManifest(actual, manifest.source) || actual.excluded.length !== 0)
    throw new Error("Extracted release SourceManifest differs");
}

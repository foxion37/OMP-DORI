import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDigest } from "../src/release/files.ts";
import { assertNativeSource } from "../src/release/native.ts";
import { digest } from "../src/update/source.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: native admission fixtures build private directories that POSIX mode bits mark.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
const readSync = fs.readSync;
const chunkSize = 1024 * 1024;
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "cataly-file-digest-")));
  roots.push(root);
  return root;
}

test.each([0, 1, chunkSize - 1, chunkSize, chunkSize + 1, chunkSize * 3 + 17])(
  "file digest hashes all %i bytes with reads bounded by one chunk",
  (size) => {
    const path = join(fixture(), "binary");
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.writeFileSync(path, bytes);
    let requested = 0;
    const read = spyOn(fs, "readSync").mockImplementation(
      new Proxy(readSync, {
        apply(target, receiver, args) {
          requested = Math.max(requested, args[3], args[1].byteLength);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    try {
      expect(fileDigest(path)).toBe(digest(bytes));
    } finally {
      read.mockRestore();
    }
    expect(requested).toBeLessThanOrEqual(chunkSize);
  },
);

test("short reads continue until EOF and unused buffer bytes never enter the digest", () => {
  const path = join(fixture(), "short");
  const bytes = Buffer.from("short reads are not EOF; the tail must be hashed too");
  fs.writeFileSync(path, bytes);
  const read = spyOn(fs, "readSync").mockImplementation(
    new Proxy(readSync, {
      apply(target, receiver, args) {
        args[3] = 7;
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  try {
    expect(fileDigest(path)).toBe(digest(bytes));
    expect(read.mock.calls.length).toBeGreaterThan(2);
  } finally {
    read.mockRestore();
  }
});

test("open and read failures propagate and a read failure still closes the descriptor", () => {
  const path = join(fixture(), "missing");
  expect(() => fileDigest(path)).toThrow();
  fs.writeFileSync(path, "read failure");
  const error = new Error("injected read failure");
  let fd = -1;
  const read = spyOn(fs, "readSync").mockImplementation((file) => {
    fd = file;
    throw error;
  });
  try {
    expect(() => fileDigest(path)).toThrow(error);
    expect(() => fs.fstatSync(fd)).toThrow();
  } finally {
    read.mockRestore();
  }
});

test("pathname replacement between chunks does not switch the opened file", () => {
  const root = fixture();
  const path = join(root, "binary");
  const bytes = Buffer.alloc(chunkSize * 2 + 1, 17);
  fs.writeFileSync(path, bytes);
  let replaced = false;
  const read = spyOn(fs, "readSync").mockImplementation(
    new Proxy(readSync, {
      apply(target, receiver, args) {
        const count = Reflect.apply(target, receiver, args);
        if (!replaced) {
          replaced = true;
          fs.renameSync(path, join(root, "opened"));
          fs.writeFileSync(path, Buffer.alloc(bytes.length, 23));
        }
        return count;
      },
    }),
  );
  try {
    expect(fileDigest(path)).toBe(digest(bytes));
  } finally {
    read.mockRestore();
  }
  expect(fileDigest(path)).toBe(digest(Buffer.alloc(bytes.length, 23)));
});

posix("native admission hashes the addon bytes and rejects a changed final addon chunk", () => {
  const root = fixture();
  const f = overlayFixture(join(root, "bundle"), join(root, "upstream"));
  const home = join(root, "home");
  const receipt = nativeCacheFixture(f.source, home, f.checkout);
  const bytes = Buffer.alloc(chunkSize * 2 + 17, 41);
  fs.writeFileSync(receipt.addon, bytes);
  fs.writeFileSync(join(receipt.directory, "receipt.json"), JSON.stringify({ ...receipt, addonHash: digest(bytes) }));
  expect(assertNativeSource(f.source, home).identity).toBe(receipt.identity);
  bytes[bytes.length - 1] = 42;
  fs.writeFileSync(receipt.addon, bytes);
  expect(() => assertNativeSource(f.source, home)).toThrow("receipt differs");
});

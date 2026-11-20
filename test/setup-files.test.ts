import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDigest } from "../src/release/files.ts";
import { assertSetupFile, captureSetupFile, publishSetupFile, setupPreview } from "../src/setup-files.ts";
import { saveDeploymentText } from "../src/update/deployment-files.ts";
import { digest } from "../src/update/source.ts";

// POSIX-only: the setup writer enforces POSIX ownership, mode bits, and group preservation.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dori-setup-files-")));
  roots.push(root);
  return { root, path: join(root, "config.json") };
}

posix("publication is private, exact, mode-preserving and a no-op for identical bytes", () => {
  const f = fixture();
  const text = '{"unknown":{"owner":"value"}}\n';
  const absent = captureSetupFile(f.path);
  expect(setupPreview(absent, text, ["runtime"])).toMatchObject({ action: "create", beforeSha256: null });
  const first = publishSetupFile(absent, text);
  expect(first.sha256).toBe(digest(text));
  expect(first.mode).toBe(0o600);
  expect(fs.readFileSync(f.path, "utf8")).toBe(text);
  expect(publishSetupFile(first, text)).toEqual(first);
  expect(captureSetupFile(f.path)).toEqual(first);
  fs.chmodSync(f.path, 0o640);
  const changed = publishSetupFile(captureSetupFile(f.path), `${text}\n`);
  expect(changed.mode).toBe(0o640);
  expect(fs.readdirSync(f.root)).toEqual(["config.json"]);
});

posix("replacement applies the original group before publishing its permissions", () => {
  const f = fixture();
  fs.writeFileSync(f.path, "old", { mode: 0o640 });
  const before = captureSetupFile(f.path);
  const gid = fs.statSync(f.path).gid;
  expect(before.gid).toBe(gid);
  const chown = spyOn(fs, "fchownSync");
  try {
    const after = publishSetupFile(before, "new");
    expect(after.gid).toBe(before.gid);
    expect(after.mode).toBe(before.mode);
    expect(chown).toHaveBeenCalledTimes(1);
    expect(chown.mock.calls[0]!.slice(1)).toEqual([-1, gid]);
  } finally {
    chown.mockRestore();
  }
});

posix.each(["edit", "replace", "chmod"])("stale %s snapshots cannot overwrite an owner's change", (kind) => {
  const f = fixture();
  fs.writeFileSync(f.path, "original", { mode: 0o600 });
  const before = captureSetupFile(f.path);
  if (kind === "edit") fs.writeFileSync(f.path, "owner edit");
  if (kind === "replace") {
    fs.renameSync(f.path, join(f.root, "old"));
    fs.writeFileSync(f.path, "original", { mode: 0o600 });
  }
  if (kind === "chmod") fs.chmodSync(f.path, 0o640);
  const observed = captureSetupFile(f.path);
  expect(() => publishSetupFile(before, "installer bytes")).toThrow("Configuration changed during setup");
  expect(captureSetupFile(f.path)).toEqual(observed);
});

posix("new configuration appearing during preparation is preserved", () => {
  const f = fixture();
  const before = captureSetupFile(f.path);
  fs.writeFileSync(f.path, "owner-created", { mode: 0o600 });
  expect(() => publishSetupFile(before, "installer")).toThrow("Configuration changed during setup");
  expect(fs.readFileSync(f.path, "utf8")).toBe("owner-created");
});

posix("the last pre-publication check detects an edit during staging and removes only its temporary", () => {
  const f = fixture();
  fs.writeFileSync(f.path, "original", { mode: 0o600 });
  const before = captureSetupFile(f.path);
  const original = fs.fsyncSync;
  let edited = false;
  const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    original(fd);
    if (!edited) {
      edited = true;
      fs.writeFileSync(f.path, "owner-during-stage");
    }
  });
  try {
    expect(() => publishSetupFile(before, "installer")).toThrow("Configuration changed during setup");
  } finally {
    sync.mockRestore();
  }
  expect(edited).toBe(true);
  expect(fs.readFileSync(f.path, "utf8")).toBe("owner-during-stage");
  expect(fs.readdirSync(f.root)).toEqual(["config.json"]);
});

posix("no-clobber publication survives a creator after its last check", () => {
  const f = fixture();
  expect(() =>
    saveDeploymentText(f.path, "installer", {
      createOnly: true,
      beforePublish: () => fs.writeFileSync(f.path, "owner-won", { mode: 0o600 }),
    }),
  ).toThrow();
  expect(fs.readFileSync(f.path, "utf8")).toBe("owner-won");
  expect(fs.readdirSync(f.root)).toEqual(["config.json"]);
});

posix("staged publication never exposes incomplete target bytes", () => {
  const f = fixture();
  fs.writeFileSync(f.path, "old", { mode: 0o600 });
  saveDeploymentText(f.path, "complete-new", {
    beforePublish: () => {
      expect(fs.readFileSync(f.path, "utf8")).toBe("old");
      const staged = fs.readdirSync(f.root).filter((name) => name.endsWith(".tmp"));
      expect(staged).toHaveLength(1);
      expect(fs.readFileSync(join(f.root, staged[0]!), "utf8")).toBe("complete-new");
      expect(fs.statSync(join(f.root, staged[0]!)).mode & 0o777).toBe(0o600);
    },
  });
  expect(fs.readFileSync(f.path, "utf8")).toBe("complete-new");
});

posix("symlink files, symlink parents and writable shared targets are not setup-owned", () => {
  const f = fixture();
  const actual = join(f.root, "actual");
  fs.writeFileSync(actual, "owner", { mode: 0o600 });
  fs.symlinkSync(actual, f.path);
  expect(() => captureSetupFile(f.path)).toThrow("Expected a real file");
  const alias = join(f.root, "alias");
  fs.symlinkSync(f.root, alias);
  expect(() => captureSetupFile(join(alias, "actual"))).toThrow("Unsafe directory");
  fs.chmodSync(actual, 0o666);
  expect(() => captureSetupFile(actual)).toThrow("Group/world-writable");
  const shared = join(f.root, "shared");
  fs.mkdirSync(shared, { mode: 0o777 });
  fs.chmodSync(shared, 0o777);
  expect(() => captureSetupFile(join(shared, "new"))).toThrow("Group/world-writable");
});

posix("snapshot hashing detects path replacement during its descriptor read", () => {
  const f = fixture();
  fs.writeFileSync(f.path, "before", { mode: 0o600 });
  const original = fs.readSync;
  let replaced = false;
  const read = spyOn(fs, "readSync").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        if (!replaced) {
          replaced = true;
          fs.renameSync(f.path, join(f.root, "old"));
          fs.writeFileSync(f.path, "after", { mode: 0o600 });
        }
        return result;
      },
    }),
  );
  try {
    expect(() => captureSetupFile(f.path)).toThrow("Configuration changed while being read");
  } finally {
    read.mockRestore();
  }
  expect(fs.readFileSync(f.path, "utf8")).toBe("after");
});

posix("the shared digest leaves caller-owned descriptors open and snapshots add no size restriction", () => {
  const f = fixture();
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 23);
  fs.writeFileSync(f.path, bytes, { mode: 0o600 });
  const fd = fs.openSync(f.path, "r");
  try {
    expect(fileDigest(fd)).toBe(digest(bytes));
    expect(fs.fstatSync(fd).size).toBe(bytes.length);
  } finally {
    fs.closeSync(fd);
  }
  expect(captureSetupFile(f.path).sha256).toBe(digest(bytes));
  assertSetupFile(captureSetupFile(f.path));
});

import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import { acquireBundle } from "../src/release/bundle.ts";
import { installBundle } from "../src/release/install.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { digest } from "../src/update/source.ts";
import { archive, fixture, withArchive } from "./release-consumer-setup.ts";

test("tampered archive and tampered manifest fail before changing the active source or state", async () => {
  const f = fixture();
  const first = f.release("first\n");
  await installBundle(f.paths, first.bundle, undefined);
  const oldPointer = readlinkSync(f.paths.live);
  const oldState = readFileSync(f.paths.state);
  const next = f.release("second\n");
  const altered = Buffer.from(next.bytes);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  writeFileSync(join(next.dist, next.bundle.manifest.archive.name), altered);
  await expect(acquireBundle({ from: next.dist })).rejects.toThrow("checksum");
  writeFileSync(join(next.dist, next.bundle.manifest.archive.name), next.bytes);
  const metadata = JSON.parse(readFileSync(join(next.dist, "release-manifest.json"), "utf8"));
  metadata.source.files[0].sha256 = "0".repeat(64);
  const changed = JSON.stringify(metadata);
  writeFileSync(join(next.dist, "release-manifest.json"), changed);
  writeFileSync(
    join(next.dist, "SHA256SUMS"),
    `${digest(next.bytes)}  ${metadata.archive.name}\n${digest(changed)}  release-manifest.json\n`,
  );
  await expect(acquireBundle({ from: next.dist })).rejects.toThrow("manifest hash");
  expect(readlinkSync(f.paths.live)).toBe(oldPointer);
  expect(readFileSync(f.paths.state)).toEqual(oldState);
});

test("tar traversal, absolute paths, duplicate files, links and device entries are rejected before extraction", () => {
  const f = fixture();
  const release = f.release("public\n");
  const root = release.bundle.manifest.archive.root;
  const unsafe = [
    { name: `${root}/../../outside`, bytes: "escape" },
    { name: "/outside", bytes: "escape" },
    { name: `${root}/link`, kind: "2" },
    { name: `${root}/hardlink`, kind: "1" },
    { name: `${root}/device`, kind: "3" },
    { name: `${root}/fifo`, kind: "6" },
    { name: `${root}/metadata`, kind: "x" },
    { name: `${root}/bad${String.fromCharCode(1)}name`, bytes: "control" },
    { name: `${root}/bad${String.fromCharCode(127)}name`, bytes: "delete" },
    { name: `${root}/bad name`, bytes: "space" },
    { name: `${root}/bad\\name`, bytes: "backslash" },
    release.entries[0]!,
  ];
  for (const entry of unsafe) {
    const bytes = archive([...release.entries, entry]);
    const manifest = withArchive(release.bundle.manifest, bytes);
    expect(() => readArchive(bytes, manifest)).toThrow();
  }
  expect(existsSync(f.paths.live)).toBe(false);
  expect(existsSync(join(f.root, "outside"))).toBe(false);
});

test("an archive with a recomputed checksum still fails when actual bytes or executable bits differ", () => {
  const f = fixture();
  const release = f.release("public\n");
  for (const field of ["bytes", "mode"] as const) {
    const entries = release.entries.map((entry) =>
      entry.name.endsWith("/bin-entry.sh")
        ? { ...entry, ...(field === "bytes" ? { bytes: "changed\n" } : { mode: 0o644 }) }
        : entry,
    );
    const bytes = archive(entries);
    expect(() => readArchive(bytes, withArchive(release.bundle.manifest, bytes))).toThrow("bytes/mode");
  }
});

test("secret paths and false source-manifest hashes are rejected independently of archive checksums", () => {
  const f = fixture();
  const release = f.release("public\n").bundle.manifest;
  const secret = [{ path: "auth.json", sha256: digest("secret"), executable: false }];
  expect(() =>
    validateReleaseManifest({
      ...release,
      source: {
        version: 1,
        ulwPresent: false,
        excluded: [],
        files: secret,
        hash: digest(JSON.stringify({ files: secret, ulwPresent: false })),
      },
    }),
  ).toThrow("unsafe");
  expect(() => validateReleaseManifest({ ...release, source: { ...release.source, hash: "0".repeat(64) } })).toThrow(
    "manifest hash",
  );
});

test("existing source directories, stable non-link collisions and unsafe ancestors preserve owner bytes", async () => {
  const f = fixture();
  const release = f.release("public\n");
  const extension = join(f.paths.home, ".omp/agent/extensions/omp-dori");
  mkdirSync(extension, { recursive: true, mode: 0o700 });
  writeFileSync(join(extension, "owner.txt"), "keep\n", { mode: 0o600 });
  await expect(installBundle(f.paths, release.bundle, undefined)).rejects.toThrow("Unmanaged source/path");
  expect(readFileSync(join(extension, "owner.txt"), "utf8")).toBe("keep\n");
  expect(loadInstalled(f.paths)).toBeUndefined();
  const g = fixture();
  const other = join(g.root, "owner-source");
  mkdirSync(other, { mode: 0o700 });
  symlinkSync(other, join(g.paths.home, ".agents"));
  await expect(installBundle(g.paths, g.release("public\n").bundle, undefined)).rejects.toThrow("Unsafe directory");
  expect(readlinkSync(join(g.paths.home, ".agents"))).toBe(other);
  const h = fixture();
  mkdirSync(h.paths.live, { mode: 0o700 });
  writeFileSync(join(h.paths.live, "owner.txt"), "checkout work\n", { mode: 0o600 });
  await expect(installBundle(h.paths, h.release("public\n").bundle, undefined)).rejects.toThrow(
    "Unmanaged source/path",
  );
  expect(readFileSync(join(h.paths.live, "owner.txt"), "utf8")).toBe("checkout work\n");
});

test("a modified retained release or dependency holds rollback/update instead of resetting files", async () => {
  const f = fixture();
  const first = f.release("first\n");
  const installed = await installBundle(f.paths, first.bundle, undefined);
  const source = releasePath(f.paths, installed.current);
  chmodSync(join(source, "payload.txt"), 0o600);
  writeFileSync(join(source, "payload.txt"), "owner modification\n");
  await expect(installBundle(f.paths, first.bundle, installed)).rejects.toThrow("source bytes");
  expect(readFileSync(join(source, "payload.txt"), "utf8")).toBe("owner modification\n");
  const g = fixture();
  writeFileSync(join(g.ownedDependency, "index.ts"), "local change\n");
  await expect(installBundle(g.paths, g.release("first\n").bundle, undefined)).rejects.toThrow("checkout changed");
  expect(readFileSync(join(g.ownedDependency, "index.ts"), "utf8")).toBe("local change\n");
  expect(loadInstalled(g.paths)).toBeUndefined();
});

test("active and retained release tags reject changed commit, tree, source or archive bindings before installation", async () => {
  const f = fixture();
  const first = f.release("first\n");
  const one = await installBundle(f.paths, first.bundle, undefined);
  const second = f.release("second\n");
  const two = await installBundle(f.paths, second.bundle, one);
  const third = f.release("third\n");
  const three = await installBundle(f.paths, third.bundle, two);
  const replacement = f.release("different public source\n");
  const pointer = readlinkSync(f.paths.live);
  const state = readFileSync(f.paths.state);
  const config = readFileSync(f.paths.config);
  const retained = readdirSync(f.paths.releases).sort();
  const receipts = readdirSync(f.paths.manifests)
    .sort()
    .map((name) => [name, readFileSync(join(f.paths.manifests, name))]);
  const dependencies = readdirSync(f.paths.dependencies).sort();
  const staging = readdirSync(f.paths.staging).sort();
  for (const known of [first, second, third]) {
    const original = known.bundle.manifest;
    const changedArchive = Buffer.from(known.bytes);
    changedArchive[4] = changedArchive[4]! ^ 1;
    const changedSource = archive(
      replacement.entries.map((entry) => ({
        ...entry,
        name: `${original.archive.root}/${entry.name.slice(replacement.bundle.manifest.archive.root.length + 1)}`,
      })),
    );
    const reboundSource = withArchive(
      validateReleaseManifest({
        ...replacement.bundle.manifest,
        releaseVersion: original.releaseVersion,
        tag: original.tag,
        archive: {
          ...replacement.bundle.manifest.archive,
          name: original.archive.name,
          root: original.archive.root,
        },
      }),
      changedSource,
    );
    const variants = [
      { manifest: validateReleaseManifest({ ...original, commit: "f".repeat(40) }), bytes: known.bytes },
      { manifest: validateReleaseManifest({ ...original, tree: "b".repeat(40) }), bytes: known.bytes },
      { manifest: withArchive(original, changedArchive), bytes: changedArchive },
      { manifest: reboundSource, bytes: changedSource },
    ];
    for (const { manifest, bytes } of variants) {
      const bundle = { manifest, files: readArchive(bytes, manifest) };
      await expect(installBundle(f.paths, bundle, three)).rejects.toThrow("already bound");
      expect(readlinkSync(f.paths.live)).toBe(pointer);
      expect(readFileSync(f.paths.state)).toEqual(state);
      expect(readFileSync(f.paths.config)).toEqual(config);
      expect(readdirSync(f.paths.releases).sort()).toEqual(retained);
      expect(
        readdirSync(f.paths.manifests)
          .sort()
          .map((name) => [name, readFileSync(join(f.paths.manifests, name))]),
      ).toEqual(receipts);
      expect(readdirSync(f.paths.dependencies).sort()).toEqual(dependencies);
      expect(readdirSync(f.paths.staging).sort()).toEqual(staging);
    }
  }
});

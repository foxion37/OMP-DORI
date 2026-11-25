import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportNativeCache } from "../src/release/native-cache.ts";
import { nativeCacheFixture, overlayFixture, ownProcessCwds, ownProcessFiles } from "./source-bundle-setup.ts";

// What the report cannot confirm unused it reports as a use: a reference of any size and a source lock it cannot read.

// POSIX-only: the cache refuses group/world-writable paths, which Windows reports for every file and directory.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cache() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-native-hold-")));
  roots.push(root);
  const home = join(root, "home");
  const refs = join(root, "refs");
  mkdirSync(refs);
  // Each identity's own source is gone, so only the reference under test can name it.
  const native = (name: string) => {
    const f = overlayFixture(join(root, `source-${name}`), join(root, `upstream-${name}`), `${name} ${root}`);
    const receipt = nativeCacheFixture(f.source, home, f.checkout);
    rmSync(f.source, { recursive: true });
    return receipt;
  };
  // These filesystem-only cases leave no live writer or child; exclude unrelated host writers and descriptors.
  const reasons = (scanned: readonly string[] = [refs]) =>
    Object.fromEntries(
      reportNativeCache(home, [], scanned, ownProcessCwds, {
        table: () => "",
        files: () => ownProcessFiles([String(process.pid)]),
      }).map((entry) => [entry.directory, entry.protectedBy]),
    );
  return { root, refs, native, reasons };
}

posix.each(["node_modules", ".git"])(
  "a %s symlink is inspected even though real directories of that name are skipped",
  (name) => {
    const c = cache();
    const linked = c.native("linked");
    symlinkSync(linked.directory, join(c.refs, name));
    expect(c.reasons()[linked.directory]).toEqual([`link ${join(c.refs, name)}`]);
  },
);

posix.each(["node_modules", ".git"])("a skipped %s subtree is unknown until explicitly scanned", (name) => {
  const c = cache();
  const wrapped = c.native("wrapped");
  const free = c.native("free");
  const skipped = join(c.refs, name);
  mkdirSync(join(skipped, ".bin"), { recursive: true });
  symlinkSync(wrapped.omp, join(skipped, ".bin/omp"));
  const hidden = c.reasons();
  const unknown = `unscanned directory ${skipped}`;
  expect(hidden[wrapped.directory]).toEqual([unknown]);
  expect(hidden[free.directory]).toEqual([unknown]);
  // Explicit roots are walked even when their basename would be skipped below another root.
  const scanned = c.reasons([c.refs, skipped]);
  expect(scanned[wrapped.directory]).toEqual([`link ${join(skipped, ".bin/omp")}`]);
  expect(scanned[free.directory]).toEqual([]);
  const alias = join(c.root, "scan-alias");
  symlinkSync(skipped, alias);
  expect(c.reasons([c.refs, alias])).toEqual(scanned);
  // Opting into an outer subtree must not hide a still-skipped nested subtree.
  const nested = join(skipped, name === ".git" ? "node_modules" : ".git");
  mkdirSync(nested);
  symlinkSync(free.omp, join(nested, "omp"));
  expect(c.reasons([c.refs, alias])[free.directory]).toEqual([`unscanned directory ${nested}`]);
  const complete = c.reasons([c.refs, alias, nested]);
  expect(complete[free.directory]).toEqual([`link ${join(nested, "omp")}`]);
  expect(complete[wrapped.directory]).toEqual([`link ${join(skipped, ".bin/omp")}`]);
});

posix("a reference file larger than any limit is read whole, directly or behind a link", () => {
  const c = cache();
  const direct = c.native("direct");
  const linked = c.native("linked");
  const free = c.native("free");
  // The name sits past the first MiB, so a reader that stops early misses it.
  const big = (omp: string) => `${" ".repeat(1024 * 1024 + 17)}${JSON.stringify({ omp })}\n`;
  writeFileSync(join(c.refs, "release.json"), big(direct.omp));
  const outside = join(c.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "release.json"), big(linked.omp));
  symlinkSync(join(outside, "release.json"), join(c.refs, "linked.json"));
  const reasons = c.reasons();
  expect(reasons[direct.directory]).toEqual([`reference ${join(c.refs, "release.json")}`]);
  expect(reasons[linked.directory]).toEqual([`reference ${join(c.refs, "linked.json")}`]);
  expect(reasons[free.directory]).toEqual([]);
});

posix(
  "a linked directory the scan does not walk is reported against every identity, even when its lock binds another",
  () => {
    const c = cache();
    const wrapped = c.native("wrapped");
    const wrapper = `#!/bin/sh\nexec ${wrapped.omp} "$@"\n`;
    // A valid source of another identity outside the roots, holding a wrapper of this one.
    const outside = join(c.root, "outside");
    overlayFixture(outside, join(c.root, "upstream-other"), `other ${c.root}`);
    writeFileSync(join(outside, "omp"), wrapper);
    symlinkSync(outside, join(c.refs, "release"));
    // A directory inside a root that the walk skips (node_modules), reached through a link.
    const hidden = join(c.refs, "node_modules/wrappers");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "omp"), wrapper);
    symlinkSync(hidden, join(c.refs, "active"));
    expect([...(c.reasons()[wrapped.directory] ?? [])].sort()).toEqual(
      [
        `link to an unscanned directory ${join(c.refs, "release")}`,
        `link to an unscanned directory ${join(c.refs, "active")}`,
        `unscanned directory ${join(c.refs, "node_modules")}`,
      ].sort(),
    );
  },
);

posix(
  "a link that cannot be resolved for another reason than a missing target is reported against every identity",
  () => {
    const c = cache();
    const wrapped = c.native("wrapped");
    // A wrapper behind a directory the scan may not enter.
    const closed = join(c.root, "closed");
    mkdirSync(closed);
    writeFileSync(join(closed, "omp"), `#!/bin/sh\nexec ${wrapped.omp} "$@"\n`);
    symlinkSync(join(closed, "omp"), join(c.refs, "omp"));
    // A loop of links, and a link whose target is simply gone (that one names nothing).
    symlinkSync(join(c.root, "hop"), join(c.refs, "loop"));
    symlinkSync(join(c.refs, "loop"), join(c.root, "hop"));
    symlinkSync(join(c.root, "gone"), join(c.refs, "dangling"));
    chmodSync(closed, 0);
    try {
      expect([...(c.reasons()[wrapped.directory] ?? [])].sort()).toEqual(
        [`unresolved link ${join(c.refs, "omp")}`, `unresolved link ${join(c.refs, "loop")}`].sort(),
      );
    } finally {
      chmodSync(closed, 0o700);
    }
  },
);

posix("a linked directory whose source lock cannot be read is reported against every identity", () => {
  const c = cache();
  const wrapped = c.native("wrapped");
  const outside = join(c.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "omp"), `#!/bin/sh\nexec ${wrapped.omp} "$@"\n`);
  writeFileSync(join(outside, "native-omp.lock"), "{}");
  symlinkSync(outside, join(c.refs, "wrappers"));
  expect(c.reasons()[wrapped.directory]).toEqual([
    `unreadable source lock ${join(c.refs, "wrappers")}`,
    `link to an unscanned directory ${join(c.refs, "wrappers")}`,
  ]);
});

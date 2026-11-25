import { afterEach, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSourceAdmission, sourceManifest } from "../src/update/source.ts";
import { removeUlwFixture } from "../src/update/ulw-fixture.ts";
import { fixture, git, it } from "./update-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PIN = "6ec7ecd40b2b5667f37c9802999db1d12ebbc2ae";

/** `ref/omp-ulw` as the old setup action left it: `git init`, then a fetch of the pinned commit by URL, no remote. */
function setupActionFixture(root: string, url = "https://github.com/dbc-hbin/omp-ulw"): string {
  const checkout = join(root, "ref/omp-ulw");
  mkdirSync(checkout, { recursive: true, mode: 0o700 });
  git(checkout, "init", "-q");
  writeFileSync(join(checkout, ".git/FETCH_HEAD"), `${PIN}\t\t'${PIN}' of ${url}\n`);
  writeFileSync(join(checkout, "index.ts"), "export default function ulw() {}\n");
  return checkout;
}

/** `ref/omp-ulw` as the first setup made it: a clone whose remotes are exactly these URLs. */
function cloneFixture(root: string, ...urls: string[]): string {
  const checkout = join(root, "ref/omp-ulw");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q");
  urls.forEach((url, index) => git(checkout, "remote", "add", index ? `remote${index}` : "origin", url));
  writeFileSync(join(checkout, "index.ts"), "export default function ulw() {}\n");
  return checkout;
}

const checkoutRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-ulw-fixture-")));
  roots.push(root);
  return root;
};

it("the setup action's ref/omp-ulw and the emptied ref/ are removed once, each in one line", () => {
  const root = checkoutRoot();
  const checkout = setupActionFixture(root);
  const lines: string[] = [];
  removeUlwFixture(root, (line) => lines.push(line));
  expect(lines).toEqual([
    `Removed the former omp-ulw fixture ${checkout} (a Git checkout of github.com/dbc-hbin/omp-ulw)`,
    `Removed the empty ${join(root, "ref")} directory`,
  ]);
  expect(existsSync(join(root, "ref"))).toBe(false);
  removeUlwFixture(root, (line) => lines.push(line));
  expect(lines).toHaveLength(2);
});

it("a clone of omp-ulw goes, while other ref/ entries stay and still hold local admission", () => {
  const root = checkoutRoot();
  const checkout = cloneFixture(root, "https://github.com/dbc-hbin/omp-ulw.git");
  mkdirSync(join(root, "ref/dori-superagent"));
  writeFileSync(join(root, "ref/dori-superagent/README.md"), "kept\n");
  const lines: string[] = [];
  removeUlwFixture(root, (line) => lines.push(line));
  expect(lines).toEqual([
    `Removed the former omp-ulw fixture ${checkout} (a Git checkout of github.com/dbc-hbin/omp-ulw)`,
  ]);
  expect(readFileSync(join(root, "ref/dori-superagent/README.md"), "utf8")).toBe("kept\n");
  expect(() => assertSourceAdmission(sourceManifest(root), "local")).toThrow(
    "local source admission held: ref; ref/ holds files Cataly did not create",
  );
});

it("foreign checkouts, plain directories and links named ref/omp-ulw are kept", () => {
  const cases: ((root: string) => void)[] = [
    (root) => cloneFixture(root, "https://github.com/someone/omp-ulw-fork.git"),
    (root) => cloneFixture(root, "https://github.com/dbc-hbin/omp-ulw.git", "git@github.com:someone/omp-ulw.git"),
    (root) => setupActionFixture(root, "https://example.com/github.com/dbc-hbin/omp-ulw"),
    (root) => {
      mkdirSync(join(root, "ref/omp-ulw"), { recursive: true });
      writeFileSync(join(root, "ref/omp-ulw/notes.md"), "mine\n");
    },
    (root) => {
      const elsewhere = join(root, "elsewhere");
      setupActionFixture(elsewhere);
      mkdirSync(join(root, "ref"));
      symlinkSync(join(elsewhere, "ref/omp-ulw"), join(root, "ref/omp-ulw"));
    },
  ];
  for (const make of cases) {
    const root = checkoutRoot();
    make(root);
    const before = sourceManifest(root);
    const lines: string[] = [];
    removeUlwFixture(root, (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(sourceManifest(root)).toEqual(before);
    expect(existsSync(join(root, "ref/omp-ulw"))).toBe(true);
  }
});

it("cataly upstream removes the fixture before local admission and stages from the checkout", async () => {
  const f = fixture();
  setupActionFixture(f.localSource);
  const job = (await f.updater.once("stage")).job!;
  expect(existsSync(join(f.localSource, "ref"))).toBe(false);
  expect(job.inputs?.local.excluded).not.toContain("ref");
  expect(job.commands.at(-1)?.name).toBe("port");
});

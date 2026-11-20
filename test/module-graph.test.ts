import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Glob } from "bun";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");
const TREES = ["src", "skills/dori-mode/scripts/src"];
// The skill CLI runs its command at import; it is an entry point, never imported.
const ENTRY_ONLY = new Set([join(ROOT, "skills/dori-mode/scripts/src/cli.ts")]);

const modules = (): string[] =>
  TREES.flatMap((tree) => {
    const cwd = join(ROOT, tree);
    return [...new Glob("**/*.ts").scanSync({ cwd })].map((file) => join(cwd, file));
  }).sort();

// Oxlint's import/no-cycle owns the general cycle guard; this also forbids a one-way dependency.
test("launch validation does not import its coordinator", () => {
  const skillSrc = join(ROOT, "skills/dori-mode/scripts/src");
  const input = join(skillSrc, "launch-input.ts");
  const source = ts.createSourceFile(input, readFileSync(input, "utf8"), ts.ScriptTarget.Latest);
  const imports = source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly;
    const specifier = statement.moduleSpecifier;
    if (typeOnly || !specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return [];
    return [Bun.resolveSync(specifier.text, skillSrc)];
  });
  expect(imports).not.toContain(Bun.resolveSync("./launch.ts", skillSrc));
});

test("every module loads on its own in a fresh process", async () => {
  const files = modules().filter((file) => !ENTRY_ONLY.has(file));
  expect(files.length).toBeGreaterThan(50);
  const failures: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      // Each path comes from discovery and must be imported in its own process.
      const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0 || err.trim())
        failures.push(`${relative(ROOT, file)}: exit ${code} ${err.trim().split("\n")[0] ?? ""}`);
    }),
  );
  expect(failures).toEqual([]);
}, 60_000);

/**
 * Typecheck the three TypeScript projects concurrently. Each project is an independent `tsc --noEmit`
 * run with no shared output, so the wall time is the slowest project instead of their sum.
 *
 * Prints one `TYPECHECK_FAIL <project>` block per failing project, or `TYPECHECK_OK <n> projects`,
 * and exits 1 when any project fails. Every project runs to completion before the exit status is
 * decided, so one failure never hides another.
 */
import { join } from "node:path";

const PROJECTS = ["tsconfig.json", "skills/dori-mode/scripts/tsconfig.json", "extension/tsconfig.json"] as const;

interface ProjectRun {
  readonly project: string;
  readonly status: number;
  readonly output: string;
}

const runProject = async (root: string, project: string): Promise<ProjectRun> => {
  // `bun run` puts node_modules/.bin on PATH but a direct `bun scripts/typecheck.ts` does not, so
  // resolve tsc through the project's own bin directory either way.
  const env = { ...process.env, PATH: `${join(root, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}` };
  const proc = Bun.spawn(["tsc", "--noEmit", "-p", join(root, project)], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { project, status, output: `${stdout}${stderr}`.trim() };
};

if (import.meta.main) {
  const root = process.cwd();
  // Start every project before awaiting any, so the three compilers overlap.
  const runs = await Promise.all(PROJECTS.map((project) => runProject(root, project)));
  const failed = runs.filter((run) => run.status !== 0);
  for (const run of failed) {
    console.log(`TYPECHECK_FAIL ${run.project}`);
    if (run.output) console.log(run.output);
  }
  if (failed.length) process.exit(1);
  console.log(`TYPECHECK_OK ${runs.length} projects`);
}

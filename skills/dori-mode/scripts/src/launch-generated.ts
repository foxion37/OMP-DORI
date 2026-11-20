import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GeneratedBrief = { readonly dir: string; readonly brief: string };
class GeneratedBriefError extends Error {}

/** The caller holds the launch lock. A retained private attempt is a hold, not a retry receipt. */
export const stageGeneratedBrief = (target: string, preamble: string): GeneratedBrief => {
  mkdirSync(dirname(target), { recursive: true });
  if (lstatSync(target, { throwIfNoEntry: false })) throw new GeneratedBriefError(`output already exists: ${target}`);
  const attempts = `${target}.attempts`;
  mkdirSync(attempts, { recursive: true, mode: 0o700 });
  const owner = process.getuid?.();
  const info = lstatSync(attempts);
  if (!info.isDirectory() || (owner !== undefined && (info.uid !== owner || (info.mode & 0o077) !== 0)))
    throw new GeneratedBriefError(`not a private attempt directory: ${attempts}`);
  if (readdirSync(attempts).length) throw new GeneratedBriefError(`inspect the prior attempt in ${attempts}`);
  const dir = mkdtempSync(join(attempts, "attempt-"));
  const brief = join(dir, "brief.md");
  const attempt = { dir, brief };
  try {
    writeFileSync(brief, preamble, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // No terminal was invoked. Do not leave our failed staging write as an ambiguous launch hold.
    // An exclusive-open collision is not our file, even inside the new attempt directory.
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) discardGeneratedBrief(attempt);
    throw error;
  }
  return attempt;
};

/** Remove only our private staging name, never the lane's shared brief path. */
export const discardGeneratedBrief = ({ dir, brief }: GeneratedBrief): void => {
  try {
    rmSync(brief, { force: true });
    rmdirSync(dir);
  } catch (error) {
    process.stderr.write(`dori: could not release generated brief attempt ${dir} (${String(error)})\n`);
  }
};

/** Keep the historical lane brief path; an intervening file or link wins without being overwritten. */
export const publishGeneratedBrief = (attempt: GeneratedBrief, target: string): void => {
  linkSync(attempt.brief, target);
  discardGeneratedBrief(attempt);
};

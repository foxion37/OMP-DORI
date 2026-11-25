import { lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/*
 * Leftover from before the omp-ulw removal. CI's setup action (and `bun run dev:setup`, which runs it) checked omp-ulw
 * out into a checkout's gitignored `ref/omp-ulw`: `git init` plus `git fetch https://github.com/dbc-hbin/omp-ulw <pin>`,
 * and before that a `git clone` of the same repository. Source admission holds on any `ref/`, so dev setup, local test
 * runs and local source admission remove exactly that fixture, then `ref/` once it is empty. Anything else in `ref/`
 * is kept, and still holds admission.
 */

const ULW_REPOSITORY = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]dbc-hbin\/omp-ulw(?:\.git)?\/?$/;

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** A real directory of this user, never followed through a link. */
const ownDirectory = (path: string): boolean => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() === true && (process.getuid === undefined || stat.uid === process.getuid());
};

/** The URLs of every `[remote "..."]` section of a Git config file. */
function remoteUrls(config: string): string[] {
  const urls: string[] = [];
  let remote = false;
  for (const line of config.split("\n")) {
    const section = /^\s*\[([^\]]*)\]/.exec(line)?.[1];
    if (section !== undefined) remote = /^remote\s+"/.test(section.trim());
    else if (remote) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
      if (url) urls.push(url);
    }
  }
  return urls;
}

/** A Git checkout of dbc-hbin/omp-ulw alone: its only remote, or the fetch source of a remoteless one. */
export function isUlwCheckout(checkout: string): boolean {
  const git = join(checkout, ".git");
  if (!ownDirectory(checkout) || !ownDirectory(git)) return false;
  const configured = remoteUrls(read(join(git, "config")) ?? "");
  if (configured.length) return configured.every((url) => ULW_REPOSITORY.test(url));
  const fetched = (read(join(git, "FETCH_HEAD")) ?? "").split("\n").filter((line) => line.trim());
  return fetched.length > 0 && fetched.every((line) => ULW_REPOSITORY.test(/ of (\S+)\s*$/.exec(line)?.[1] ?? ""));
}

/** Remove the former omp-ulw fixture from checkout `root`, then its emptied `ref/`; one line per removal. */
export function removeUlwFixture(root: string, log: (line: string) => void = (line) => console.error(line)): void {
  const ref = join(root, "ref");
  if (!ownDirectory(ref)) return;
  const fixture = join(ref, "omp-ulw");
  if (isUlwCheckout(fixture)) {
    rmSync(fixture, { recursive: true, force: true });
    log(`Removed the former omp-ulw fixture ${fixture} (a Git checkout of github.com/dbc-hbin/omp-ulw)`);
  }
  if (readdirSync(ref).length === 0) {
    rmdirSync(ref);
    log(`Removed the empty ${ref} directory`);
  }
}

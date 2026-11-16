import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { owned, realDirectory } from "./files.ts";
import {
  assertSourceBundle,
  bundleGit,
  readSourceBundle,
  SourceBundleError,
  type BoundBundle,
} from "./source-bundle.ts";

/** HEAD and upstream gitlinks remain intact; the index explicitly records the expected overlay. */
export async function checkoutSourceBundle(
  checkout: string,
  bundle: BoundBundle,
  home: string,
  repository = bundle.lock.repository,
): Promise<void> {
  mkdirSync(checkout, { mode: 0o700 });
  await bundleGit(["init", "--quiet", checkout], home, home);
  await bundleGit(["fetch", "--quiet", "--depth=1", "--no-tags", "--", repository, bundle.lock.commit], checkout, home);
  await bundleGit(
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", bundle.lock.commit],
    checkout,
    home,
  );
  try {
    await bundleGit(["apply", "--check", "--index", "--", bundle.patch], checkout, home);
    await bundleGit(["apply", "--index", "--", bundle.patch], checkout, home);
  } catch {
    throw new SourceBundleError("Bound source patch cannot apply to its exact upstream; preparation held");
  }
  assertSourceBundle(checkout, bundle, home);
}

export async function provisionSourceOverlay(
  source: string,
  home: string,
  target?: string,
  repository?: string,
): Promise<string> {
  const bundle = readSourceBundle(source);
  target ??= join(home, ".cache/omp-dori", `omp-ulw-${bundle.identity}`);
  if (lstatSync(target, { throwIfNoEntry: false })) assertSourceBundle(target, bundle, home);
  else {
    const stage = `${target}.preparing`;
    if (lstatSync(stage, { throwIfNoEntry: false }))
      throw new Error("Partial ULW preparation exists; preserve it before reinstalling");
    realDirectory(dirname(target), true);
    owned(dirname(target));
    await checkoutSourceBundle(stage, bundle, home, repository);
    renameSync(stage, target);
    assertSourceBundle(target, bundle, home);
  }
  return join(target, "index.ts");
}

import { mkdirSync } from "node:fs";
import { assertSourceBundle, bundleGit, SourceBundleError, type BoundBundle } from "./source-bundle.ts";

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

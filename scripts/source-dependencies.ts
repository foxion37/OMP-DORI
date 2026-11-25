import { basename, dirname, resolve } from "node:path";
import { assertNativeSource, leaseNativePath, provisionNativeSource } from "../src/release/native.ts";
import { nativeCacheRoot, scriptLeaseHolder } from "../src/release/native-cache-lease.ts";

const [action, rawSource, rawHome, rawTarget] = process.argv.slice(2);
if (!rawSource || !rawHome) throw new Error("source dependencies require an action, source root and home");
const source = resolve(rawSource);
const home = resolve(rawHome);
// The shell that runs or execs the identity holds its lease: the cache launcher's for assert-native, the named one else.
if (action === "native") {
  const receipt = await provisionNativeSource(source, home, process.execPath, scriptLeaseHolder());
  process.stdout.write(`${receipt.directory}\n`);
} else if (action === "assert-native") {
  // Existing launchers already enter their private launch-cwd. Validate that exact cache, not a preferred sibling.
  const cwd = process.cwd();
  const directory = dirname(cwd);
  const pinned = basename(cwd) === "launch-cwd" && dirname(directory) === nativeCacheRoot(home);
  const receipt = assertNativeSource(source, home, process.execPath, {
    holder: scriptLeaseHolder(),
    ...(pinned ? { directory } : {}),
  });
  process.stdout.write(`${receipt.directory}\n`);
} else if (action === "consumer") {
  const native = assertNativeSource(source, home, process.execPath, { holder: scriptLeaseHolder() });
  process.stdout.write(`${native.omp}\n`);
} else if (action === "lease-path") {
  // An explicitly selected executable a writer publishes: leased like a prepared identity when it lies in the cache.
  if (!rawTarget) throw new Error("A native lease requires the selected executable path");
  leaseNativePath(home, resolve(rawTarget), scriptLeaseHolder());
} else throw new Error("Unknown source dependency action");

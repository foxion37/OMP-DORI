import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readAutomaticState, setAutomaticEnabled } from "./automatic-state.ts";
import { acquireConsumerLock, consumerPaths } from "./files.ts";
import { consumerReleaseHome } from "./runtime.ts";
import { assertInstalledPointer, hasConsumerState, loadInstalled, verifyRelease } from "./state.ts";

export async function runAutomaticCommand(argv: string[]): Promise<number> {
  let unlock: (() => void) | undefined;
  try {
    const args = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { home: { type: "string" } } });
    const mode = args.positionals[0] ?? "status";
    if (args.positionals.length > 1 || !["status", "enable", "disable"].includes(mode))
      throw new Error("dori update auto <status|enable|disable> [--home PATH]");
    const installedHome = consumerReleaseHome(realpathSync(resolve(import.meta.dir, "../..")));
    const home = args.values.home ?? installedHome ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
    if (!isAbsolute(home)) throw new Error("Consumer home must be absolute");
    const paths = consumerPaths(homedir(), home);
    if (!hasConsumerState(paths)) throw new Error("Automatic updates are only available for managed consumer releases");
    if (mode !== "status") unlock = acquireConsumerLock(paths);
    const installed = loadInstalled(paths);
    if (!installed) throw new Error("No installed consumer release");
    assertInstalledPointer(paths, installed);
    verifyRelease(paths, installed.current);
    const automatic = mode === "status" ? readAutomaticState(paths) : setAutomaticEnabled(paths, mode === "enable");
    console.log(
      JSON.stringify(
        { installed: installed.current.tag, automatic, environmentPaused: process.env["DORI_AUTO_UPDATE"] === "0" },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(`OMP-Dori automatic update held: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    unlock?.();
  }
}

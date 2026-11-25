import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { consumerPaths, isPrimaryConsumer } from "./files.ts";
import { assertNativeSource } from "./native.ts";

/** A loaded physical release binds its home independently of the caller's inherited Cataly environment. */
export function consumerReleaseHome(source: string): string | undefined {
  if (
    !/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(basename(source)) ||
    basename(dirname(source)) !== "releases" ||
    basename(dirname(dirname(source))) !== "releases"
  )
    return undefined;
  return dirname(dirname(dirname(source)));
}

function managedWindowsAlias(command: string, cataly: string, releases: string): boolean {
  // The same Windows release root can arrive via its short, long or case-variant path.
  // Identify only the fixed launcher layout; the executable may not exist yet.
  if (process.platform !== "win32") return false;
  const path = command.replaceAll("\\", "/");
  const shim = /^(.+\/)bin\/omp$/.exec(path);
  const launcher = /^(.+\/)[a-f0-9]{40}-[a-f0-9]{16}\/scripts\/consumer\/omp$/.exec(path);
  const alias = shim?.[1] ?? launcher?.[1];
  if (!alias) return false;
  const root = shim ? cataly : releases;
  try {
    if (realpathSync(alias) === root) return true;
    const actual = statSync(alias, { bigint: true });
    const expected = statSync(root, { bigint: true });
    return actual.isDirectory() && actual.ino !== 0n && actual.ino === expected.ino && actual.dev === expected.dev;
  } catch {
    return false;
  }
}

/** Default/previously managed native commands follow this frozen release; absolute custom commands are explicit overrides. */
export function resolveConsumerOmpCommand(
  configured: readonly string[],
  {
    home = homedir(),
    sourceRoot = resolve(import.meta.dir, "../.."),
  }: { readonly home?: string; readonly sourceRoot?: string } = {},
): readonly string[] {
  const source = realpathSync(sourceRoot);
  const catalyHome = consumerReleaseHome(source);
  if (!catalyHome) return configured;
  const paths = consumerPaths(home, catalyHome);
  const first = configured[0] ?? "omp";
  const managed =
    isAbsolute(first) &&
    (first.split("/").join(sep) === join(paths.cataly, "bin", "omp") ||
      /^[a-f0-9]{40}-[a-f0-9]{16}\/scripts\/consumer\/omp$/.test(
        relative(paths.releases, first).split(sep).join("/"),
      ) ||
      managedWindowsAlias(first, paths.cataly, paths.releases));
  if (first !== "omp" && !managed) return configured;
  assertNativeSource(source, home);
  return [
    join(source, "scripts/consumer/omp"),
    "--no-extensions",
    "-e",
    join(source, "extension"),
    ...(isPrimaryConsumer(paths)
      ? []
      : [
          "--config",
          join(paths.cataly, "omp.yml"),
          "--config",
          join(paths.root, "consumer-discovery", basename(source), "omp.yml"),
        ]),
    ...configured.slice(1),
  ];
}

/** Selected process argv is one command, never shell syntax or a partial executable override. */
export function processOmpCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] | undefined {
  const raw = env["CATALY_AGENT_ARGV"];
  if (raw === undefined) return undefined;
  const selected: unknown = JSON.parse(raw);
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.some((part) => typeof part !== "string") ||
    selected[0] === ""
  )
    throw new Error("CATALY_AGENT_ARGV must be a nonempty string array with an executable");
  return selected;
}

/** Selected argv replaces only literal OMP and the marked installation's lexical/canonical defaults. */
export function resolveProcessOmpCommand(
  configured: readonly string[],
  configFile: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const selected = processOmpCommand(env);
  const installation = resolve(dirname(configFile));
  const installed =
    selected !== undefined &&
    [".omp-cataly", "releases/consumer-owner.json"].some((part) => existsSync(join(installation, part))) &&
    (configured[0] === join(installation, "bin/omp") || configured[0] === join(realpathSync(installation), "bin/omp"));
  if (selected && (configured[0] === "omp" || installed)) return [...selected, ...configured.slice(1)];
  const command = configured[0] === "omp" ? env["CATALY_AGENT_CMD"] : undefined;
  return command ? [command, ...configured.slice(1)] : configured;
}

/** Empty assignments override tokens retained by the terminal server; lanes do not host messenger bots. */
export const laneMessengerOverrides = {
  CATALY_DISCORD_TOKEN: "",
  CATALY_TELEGRAM_TOKEN: "",
} as const;

/** Only launch context crosses a terminal server boundary; paths retain the caller's OS resolution. */
export function catalyLaunchEnv(
  env: Readonly<Record<string, string | undefined>>,
  configFile: string,
  resolved: { readonly catalyHome?: string; readonly stateDir?: string } = {},
): Record<string, string> {
  const context: Record<string, string> = { CATALY_MANAGED_STARTUP: "" };
  for (const [key, path] of Object.entries({
    HOME: env["HOME"],
    CATALY_CONFIG: configFile,
    CATALY_HOME: resolved.catalyHome ?? env["CATALY_HOME"] ?? dirname(configFile),
    CATALY_STATE_DIR: resolved.stateDir ?? env["CATALY_STATE_DIR"],
  })) {
    if (path !== undefined) context[key] = path === "" || isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  }
  if (env["CATALY_AGENT_ARGV"] !== undefined) context["CATALY_AGENT_ARGV"] = env["CATALY_AGENT_ARGV"];
  return context;
}

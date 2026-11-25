import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { platform } from "../platform/index.ts";
import { consumerPaths, readJson } from "../release/files.ts";
import { validateReleaseManifest } from "../release/manifest.ts";
import { nativeDirectory, nativeLauncher, type NativeReceipt } from "../release/native.ts";
import { consumerReleaseHome } from "../release/runtime.ts";
import { readSourceBundle } from "../release/source-bundle.ts";
import { verifyRelease } from "../release/state.ts";
import { command } from "../update/deployment-process.ts";
import { classifyOmpArgv } from "./omp-argv.ts";
import { OMP_EXECUTABLE, sourceOmpArgv } from "./omp.ts";

export const NATIVE_CLI_FEATURES = ["--config", "--extension", "--no-extensions", "--model"] as const;
export type NativeCliProbe = {
  readonly kind: "omp" | "other" | "unparsed";
  readonly executable: string | null;
  readonly realpath?: string;
  readonly entry?: string;
  readonly probeExecutable?: string;
  readonly revision?: string;
  readonly version?: string;
  readonly reason?: string;
};

/** Inspect only the selected entry point; never search past a failing PATH candidate or run configured prompts. */
export async function probeNativeCli(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  expectedVersion: string,
  source?: string,
): Promise<NativeCliProbe> {
  const classified = classifyOmpArgv(argv);
  const executable = Bun.which(argv[0] ?? "", { cwd, PATH: env["PATH"] ?? "" });
  const base = { kind: classified.kind, executable };
  if (!executable) return { ...base, reason: `configured executable not found: ${JSON.stringify(argv[0])}` };
  const physical = { ...base, realpath: realpathSync(executable) };
  if (classified.kind === "other") return { ...physical, reason: "custom agent; native CLI is not requested" };
  if (classified.kind !== "omp" || classified.command.length !== argv.length)
    return { ...physical, reason: "opaque launcher or environment prefix; native CLI probe unavailable" };
  let prefix: [string, ...string[]];
  const entry = argv[1];
  if (sourceOmpArgv(argv)) {
    prefix = [
      executable,
      ...argv.slice(1, argv[3] === "--preload" ? 6 : 4).map((arg) => (arg.startsWith("-") ? arg : resolve(cwd, arg))),
    ];
  } else if (OMP_EXECUTABLE.test(argv[0] ?? "")) {
    prefix = [executable];
  } else if (
    /^(bun|node)(?:\.exe)?$/i.test(argv[0]?.split(/[\\/]/).at(-1) ?? "") &&
    entry &&
    OMP_EXECUTABLE.test(entry.replace(/\\/g, "/"))
  ) {
    prefix = [executable, resolve(cwd, entry)];
  } else {
    return { ...physical, reason: "opaque native launcher; entry point cannot be separated from runtime flags" };
  }
  let revision: string | undefined;
  let nativeEntry: string | undefined;
  let consumerSource: string | undefined;
  const ownerHome = env["HOME"];
  // Managed POSIX shell launchers cannot be admitted on Windows, even for a metadata probe.
  const consumer = source && join(source, "scripts/consumer/omp");
  const cache = ownerHome && join(ownerHome, ".cache/omp-cataly");
  if (!platform.posixOwnership && consumer) {
    const normalized = physical.realpath.replaceAll("\\", "/").toLowerCase();
    const managed = executable === consumer || (existsSync(consumer) && physical.realpath === realpathSync(consumer));
    if (managed || (cache && normalized.startsWith(`${resolve(cache).replaceAll("\\", "/").toLowerCase()}/`)))
      return { ...physical, reason: "managed native source requires protected POSIX storage" };
  }
  if (source && ownerHome && platform.posixOwnership) {
    const directory = nativeDirectory(source, ownerHome);
    const bound = join(directory, "bin/omp");
    const consumer = join(source, "scripts/consumer/omp");
    const managedConsumer =
      executable === consumer || (existsSync(consumer) && physical.realpath === realpathSync(consumer));
    const cache = join(ownerHome, ".cache/omp-cataly");
    if (managedConsumer || executable === bound || (existsSync(bound) && physical.realpath === realpathSync(bound))) {
      try {
        const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")) as NativeReceipt;
        if (
          receipt?.omp !== bound ||
          receipt.directory !== directory ||
          typeof receipt.source !== "string" ||
          typeof receipt.bun !== "string" ||
          nativeDirectory(receipt.source, ownerHome) !== directory ||
          receipt.entry !== join(directory, "source/packages/coding-agent/src/cli.ts") ||
          readFileSync(bound, "utf8") !== nativeLauncher(receipt.source, ownerHome, directory, receipt.bun)
        )
          throw new Error("managed launcher differs");
        // This exact launcher revalidates the source/receipt and holds its normal cache lease in each bounded child.
        prefix = [bound];
        nativeEntry = receipt.entry;
        if (managedConsumer) consumerSource = source;
        revision = readSourceBundle(source).lock.commit;
      } catch {
        return {
          ...physical,
          probeExecutable: bound,
          reason: "managed native source launcher differs or is unavailable",
        };
      }
    } else if (
      existsSync(cache) &&
      physical.realpath.startsWith(`${realpathSync(cache)}/native-`) &&
      physical.realpath.endsWith("/bin/omp")
    ) {
      return { ...physical, reason: "managed native source differs from the loaded pin" };
    }
  }
  const selectedEntry = nativeEntry ?? prefix.at(-1);
  const selected = {
    ...physical,
    probeExecutable: prefix[0],
    ...(selectedEntry === undefined ? {} : { entry: selectedEntry }),
  };
  const home = mkdtempSync(join(tmpdir(), "cataly-native-probe-"));
  const childEnv = {
    HOME: home,
    TMPDIR: home,
    PATH: env["PATH"] ?? "",
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  };
  let phase = "--version";
  let version: string | undefined;
  try {
    if (consumerSource) {
      const installedHome = consumerReleaseHome(consumerSource);
      if (installedHome) {
        phase = "managed consumer release verification";
        const paths = consumerPaths(ownerHome, installedHome);
        const manifest = validateReleaseManifest(readJson(join(paths.manifests, `${basename(consumerSource)}.json`)));
        if (verifyRelease(paths, manifest) !== consumerSource) throw new Error("Retained release identity differs");
      } else {
        phase = "managed consumer wrapper source check";
        if (!existsSync(join(consumerSource, ".git")))
          return { ...selected, reason: "configured consumer source has no Git checkout or retained release manifest" };
        const git = Bun.which("git", { cwd, PATH: env["PATH"] ?? "" });
        if (!git) return { ...selected, reason: "managed consumer wrapper source check requires Git" };
        const tracked = await command(
          [git, "-C", consumerSource, "show", "HEAD:scripts/consumer/omp"],
          home,
          childEnv,
          5_000,
        );
        if (readFileSync(executable, "utf8").trim() !== tracked)
          return { ...selected, reason: "configured consumer wrapper differs from the loaded Git revision" };
      }
      phase = "--version";
    }
    const output = await command([...prefix, phase], home, childEnv, 5_000);
    const parsed = /^(?:omp\/)?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/.exec(output)?.[1];
    if (!parsed) return { ...selected, reason: "--version did not return an exact native version" };
    version = parsed;
    if (version !== expectedVersion)
      return { ...selected, version, reason: `version differs from pinned native ${expectedVersion}` };
    phase = "--help";
    const help = await command([...prefix, phase], home, childEnv, 5_000);
    const flags = new Set([...help.matchAll(/(?:^|[\s,(])(--[a-z][a-z-]*)(?=$|[\s,)=<])/gm)].map((match) => match[1]));
    const missing = NATIVE_CLI_FEATURES.filter((feature) => !flags.has(feature));
    return {
      ...selected,
      version,
      ...(missing.length
        ? { reason: `missing public CLI feature: ${missing.join(", ")}` }
        : revision === undefined
          ? {}
          : { revision }),
    };
  } catch {
    return {
      ...selected,
      ...(version === undefined ? {} : { version }),
      reason: `${phase} failed or timed out; native CLI capability unavailable`,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

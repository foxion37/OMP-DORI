import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { expandHome, isOmpCommand } from "../../skills/dori-mode/scripts/src/config.ts";
import { canonical, contains, object, UpdateError } from "./config.ts";
import { checkNativeArgv } from "./native-argv.ts";
import { parsePromotionConfig } from "./publish-config.ts";
import type { UpdateCommand, UpdateConfig } from "./types.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const COMMAND_KEYS = ["name", "argv", "timeoutMs", "cwd"] as const;
const CONFIG_KEYS = [
  "version",
  "target",
  "runtime",
  "root",
  "remote",
  "ref",
  "baseUpstream",
  "localSource",
  "intervalSeconds",
  "worker",
  "reviewer",
  "provision",
  "checks",
  "modelEnv",
  "modelAgentDir",
  "reporter",
  "reporterEnv",
  "promotion",
] as const;
const RESERVED_ENV =
  /^(?:HOME|PATH|TMP.*|TEMP|XDG_.*|DORI_.*|PI_.*|OMP_.*|BUN_.*|NODE_.*|GIT_.*|GH_.*|GITHUB_.*|SSH_.*|HERDR_.*|HC_.*|DO_NOT_TRACK)$/;
const MESSENGER_ENV = /^DORI_(?:SLACK_TOKEN|SLACK_COOKIE|TELEGRAM_TOKEN|DISCORD_TOKEN)$/;
const REPORTER_TOKENS = /\{(?!text\}|job\}|upstream\}|phase\})\w+\}/;

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new UpdateError(`${label} must be a nonempty string`);
  }
  return value;
};
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && !!item && !item.includes("\0"))) {
    throw new UpdateError(`${label} must be an array of nonempty strings`);
  }
  return value;
};
const positive = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new UpdateError(`${label} must be a positive integer`);
  }
  return value;
};
const allow = (raw: Record<string, unknown>, names: readonly string[], label: string): void => {
  for (const key of Object.keys(raw)) if (!names.includes(key)) throw new UpdateError(`${label}.${key} is unknown`);
};

/** Direct OMP invocations get the native final-message parser, isolation flags and capability guards. */
export const nativeAgent = (command: UpdateCommand): boolean =>
  command.engine === "omp" || (command.engine === undefined && isOmpCommand(command.argv));

const command = (value: unknown, label: string, agent = false): UpdateCommand => {
  if (!object(value)) throw new UpdateError(`${label} must configure a real argv command`);
  allow(value, agent ? [...COMMAND_KEYS, "engine"] : COMMAND_KEYS, label);
  const argv = strings(value["argv"], `${label}.argv`);
  if (!argv.length) throw new UpdateError(`${label}.argv must name a real executable`);
  const name = text(value["name"], `${label}.name`);
  if (!NAME.test(name)) throw new UpdateError(`${label}.name must match ${NAME}`);
  const cwd = value["cwd"] === undefined ? undefined : text(value["cwd"], `${label}.cwd`);
  if (cwd !== undefined && (isAbsolute(cwd) || cwd.split(/[\\/]/).includes(".."))) {
    throw new UpdateError(`${label}.cwd must be relative to the isolated candidate`);
  }
  const engine = value["engine"];
  if (engine !== undefined && engine !== "omp" && engine !== "external") {
    throw new UpdateError(`${label}.engine must be omp or external`);
  }
  return {
    name,
    argv,
    timeoutMs: positive(value["timeoutMs"], `${label}.timeoutMs`),
    ...(cwd === undefined ? {} : { cwd }),
    ...(engine === undefined ? {} : { engine }),
  };
};
const commands = (value: unknown, label: string): UpdateCommand[] => {
  if (!Array.isArray(value)) throw new UpdateError(`${label} must be an array of commands`);
  return value.map((item, at) => command(item, `${label}[${at}]`));
};

const envNames = (value: unknown, label: string): string[] => {
  const names = strings(value ?? [], label);
  for (const name of names) {
    const messenger = label === "reporterEnv" && MESSENGER_ENV.test(name);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || (RESERVED_ENV.test(name) && !messenger)) {
      throw new UpdateError(`${label} contains reserved or invalid environment name ${name}`);
    }
  }
  return names;
};

const checkAgent = (agent: UpdateCommand, label: string): void => {
  if (!agent.argv.some((arg) => arg.includes("{prompt}") || arg.includes("{brief}"))) {
    throw new UpdateError(`${label}.argv must consume {prompt} or {brief}`);
  }
  if (agent.cwd !== undefined) throw new UpdateError(`${label}.cwd is fixed to the candidate`);
  if (!nativeAgent(agent)) return; // an explicit external wrapper owns its own fresh-context and capability contract
  checkNativeArgv(agent.argv, label);
};

const remoteOf = (value: unknown, base: string): string => {
  const remote = text(value, "remote");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(remote)) {
    const path = canonical(resolve(base, remote));
    if (!existsSync(path)) throw new UpdateError("local remote path does not exist");
    return path;
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new UpdateError("remote is not a valid URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "file:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new UpdateError("remote must be public HTTPS without credentials, or a local Git path/file URL");
  }
  return remote;
};

export function loadUpdateConfig(path: string): UpdateConfig {
  const file = resolve(path);
  const base = dirname(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UpdateError(
      `update config is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!object(raw)) throw new UpdateError("update config must be an object");
  allow(raw, CONFIG_KEYS, "update");
  if (raw["version"] !== 1 || raw["target"] !== "dori" || raw["runtime"] !== "herdr") {
    throw new UpdateError('update requires version:1, target:"dori", runtime:"herdr"');
  }
  const root = canonical(resolve(base, text(raw["root"], "root")));
  const localSource = resolve(base, text(raw["localSource"], "localSource"));
  const sourceTarget = canonical(localSource);
  if (!existsSync(sourceTarget) || !lstatSync(sourceTarget).isDirectory()) {
    throw new UpdateError("localSource must resolve to an existing source directory");
  }
  if (contains(root, sourceTarget) || contains(sourceTarget, root)) {
    throw new UpdateError("root and localSource must be separate, nonoverlapping directories");
  }
  const ref = text(raw["ref"], "ref");
  if (
    !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref) ||
    ref.includes("..") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  ) {
    throw new UpdateError("ref must be one full refs/heads/... reference");
  }
  const baseUpstream = text(raw["baseUpstream"], "baseUpstream");
  if (!SHA.test(baseUpstream)) throw new UpdateError("baseUpstream must be an exact Git SHA");
  const worker = command(raw["worker"], "worker", true);
  const reviewer = command(raw["reviewer"], "reviewer", true);
  checkAgent(worker, "worker");
  checkAgent(reviewer, "reviewer");
  const checks = commands(raw["checks"], "checks");
  if (!checks.length) throw new UpdateError("checks must contain actual verification commands");
  const provision = commands(raw["provision"] ?? [], "provision");
  const reporter = raw["reporter"] === undefined ? undefined : command(raw["reporter"], "reporter");
  const names = [worker, reviewer, ...provision, ...checks, ...(reporter ? [reporter] : [])].map((item) => item.name);
  if (new Set(names).size !== names.length) throw new UpdateError("command names must be unique");
  if (
    reporter &&
    (!reporter.argv.some((arg) => arg.includes("{text}")) || reporter.argv.some((arg) => REPORTER_TOKENS.test(arg)))
  ) {
    throw new UpdateError("reporter must consume {text} and may use only {text}, {job}, {upstream}, {phase}");
  }
  const modelAgentDir =
    raw["modelAgentDir"] === undefined
      ? undefined
      : canonical(resolve(base, expandHome(text(raw["modelAgentDir"], "modelAgentDir"))));
  if (modelAgentDir !== undefined) {
    if (!existsSync(modelAgentDir) || !lstatSync(modelAgentDir).isDirectory()) {
      throw new UpdateError("modelAgentDir must reference an existing trusted model-client directory");
    }
    if (
      contains(root, modelAgentDir) ||
      contains(sourceTarget, modelAgentDir) ||
      contains(modelAgentDir, root) ||
      contains(modelAgentDir, sourceTarget)
    ) {
      throw new UpdateError("modelAgentDir must be outside candidate/source snapshots");
    }
  }
  const promotion =
    raw["promotion"] === undefined ? undefined : parsePromotionConfig(raw["promotion"], base, root, sourceTarget);
  return {
    version: 1,
    target: "dori",
    runtime: "herdr",
    root,
    remote: remoteOf(raw["remote"], base),
    ref,
    baseUpstream,
    localSource,
    intervalSeconds: positive(raw["intervalSeconds"] ?? 300, "intervalSeconds"),
    worker,
    reviewer,
    provision,
    checks,
    modelEnv: envNames(raw["modelEnv"], "modelEnv"),
    reporterEnv: envNames(raw["reporterEnv"], "reporterEnv"),
    ...(modelAgentDir === undefined ? {} : { modelAgentDir }),
    ...(reporter === undefined ? {} : { reporter }),
    ...(promotion === undefined ? {} : { promotion }),
  };
}

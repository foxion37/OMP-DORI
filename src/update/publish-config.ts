import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonical, contains, hasControl, object, UpdateError } from "./config.ts";
import { parseDeploymentConfig } from "./deployment.ts";
import type { PromotionConfig, PublishConfig } from "./publish-types.ts";

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !hasControl(value, true);
const keys = (raw: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new UpdateError("unknown promotion config key");
};
const publishRef = (value: unknown): value is string =>
  text(value) &&
  /^refs\/heads\/[A-Za-z0-9_/-][A-Za-z0-9_./-]*$/.test(value) &&
  !value.includes("..") &&
  !value.includes("//") &&
  !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) &&
  !value.endsWith("/");

export function githubRepository(config: PublishConfig): string | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(config.remote);
  return match?.[1];
}

export function parsePromotionConfig(value: unknown, base: string, root: string, source: string): PromotionConfig {
  if (!object(value) || !object(value["publish"])) throw new UpdateError("promotion requires publish config");
  keys(value, ["publish", "deployment"]);
  const raw = value["publish"];
  keys(raw, ["remote", "ref", "author", "github", "initialSource"]);
  if (!text(raw["remote"]) || !publishRef(raw["ref"])) {
    throw new UpdateError("promotion.publish requires a credential-free remote and full branch ref");
  }
  const author = raw["author"];
  if (!object(author) || !text(author["name"]) || !text(author["email"])) {
    throw new UpdateError("promotion.publish.author requires public name and email");
  }
  keys(author, ["name", "email"]);
  if (/[<>]/.test(author["name"]) || !/^[^\s<>@]+@[^\s<>@]+$/.test(author["email"])) {
    throw new UpdateError("promotion.publish.author must be a valid public Git identity");
  }
  let remote = raw["remote"];
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(remote)) remote = canonical(resolve(base, remote));
  else if (remote.startsWith("file:")) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new UpdateError("invalid promotion local Git URL");
    }
    if (url.host || url.username || url.password || url.search || url.hash) {
      throw new UpdateError("promotion local Git URL must have no host or credentials");
    }
    remote = canonical(decodeURIComponent(url.pathname));
  }
  const config: PublishConfig = { remote, ref: raw["ref"], author: { name: author["name"], email: author["email"] } };
  let initialSource: PublishConfig["initialSource"];
  if (raw["initialSource"] !== undefined) {
    const initial = raw["initialSource"];
    if (
      !object(initial) ||
      typeof initial["main"] !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(initial["main"]) ||
      typeof initial["sourceHash"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(initial["sourceHash"]) ||
      typeof initial["exportHash"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(initial["exportHash"]) ||
      typeof initial["baseUpstream"] !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(initial["baseUpstream"]) ||
      typeof initial["upstream"] !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(initial["upstream"])
    ) {
      throw new UpdateError("promotion.publish.initialSource requires exact main/source/export and upstream pins");
    }
    keys(initial, ["main", "sourceHash", "exportHash", "baseUpstream", "upstream"]);
    initialSource = {
      main: initial["main"],
      sourceHash: initial["sourceHash"],
      exportHash: initial["exportHash"],
      baseUpstream: initial["baseUpstream"],
      upstream: initial["upstream"],
    };
  }
  const repository = githubRepository(config);
  let github: PublishConfig["github"];
  if (repository) {
    const capability = raw["github"];
    if (!object(capability)) throw new UpdateError("GitHub publication requires an explicit controller capability");
    keys(capability, ["gh", "credentialHome", "requiredChecks"]);
    if (!text(capability["gh"]) || !text(capability["credentialHome"])) {
      throw new UpdateError("GitHub publication requires gh and credentialHome paths");
    }
    const gh = canonical(resolve(base, capability["gh"]));
    const credentialHome = canonical(resolve(base, capability["credentialHome"]));
    if (!lstatSync(gh, { throwIfNoEntry: false })?.isFile() || !(lstatSync(gh).mode & 0o111)) {
      throw new UpdateError("promotion gh must be an existing executable");
    }
    if (!lstatSync(credentialHome, { throwIfNoEntry: false })?.isDirectory()) {
      throw new UpdateError("promotion credentialHome must be an existing trusted directory");
    }
    for (const path of [gh, credentialHome]) {
      if (contains(root, path) || contains(source, path)) {
        throw new UpdateError("publication capability must stay outside source and updater state");
      }
    }
    const checks = capability["requiredChecks"];
    if (!Array.isArray(checks) || !checks.length || !checks.every(text) || new Set(checks).size !== checks.length) {
      throw new UpdateError("GitHub publication requires unique nonempty exact CI check names");
    }
    github = { gh, credentialHome, requiredChecks: checks };
  } else {
    if (!isAbsolute(remote) || !existsSync(remote) || raw["github"] !== undefined) {
      throw new UpdateError("publication supports local Git or credential-free https://github.com/OWNER/REPO only");
    }
    if (contains(root, remote) || contains(remote, root) || contains(source, remote) || contains(remote, source)) {
      throw new UpdateError("local publication remote must be separate from source and updater state");
    }
  }
  return {
    publish: { ...config, ...(github === undefined ? {} : { github }), ...(initialSource ? { initialSource } : {}) },
    ...(value["deployment"] === undefined ? {} : { deployment: parseDeploymentConfig(value["deployment"], base) }),
  };
}

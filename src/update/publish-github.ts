import { object, UpdateError } from "./config.ts";
import { githubRepository } from "./publish-config.ts";
import type { PublicationProcess } from "./publish-process.ts";
import { PublicationHold, type PublicationRecord } from "./publish-types.ts";

type Gate = { readonly state: "passed" | "waiting" | "held"; readonly problem?: string };
type Save = () => void;
const rows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || !value.every(object)) throw new UpdateError("GitHub publication response is incomplete");
  return value;
};

async function pullRequest(process: PublicationProcess, record: PublicationRecord, repository: string, save: Save) {
  const head = record.branch.slice("refs/heads/".length);
  const base = record.ref.slice("refs/heads/".length);
  const query = `repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${repository.split("/")[0]}:${head}`)}&base=${encodeURIComponent(base)}&per_page=100`;
  const find = async (): Promise<Record<string, unknown>[]> => {
    const pages = await process.pages(query);
    return pages.flatMap(rows).filter((pr) => object(pr["head"]) && pr["head"]["ref"] === head);
  };
  let matches = await find();
  if (!matches.length && record.pullRequest === undefined) {
    record.prIntent = true;
    save();
    try {
      await process.api(`repos/${repository}/pulls`, "POST", {
        title: `Dori OMP publication ${record.commit!.slice(0, 12)}`,
        head,
        base,
        body: `Checked source: ${record.sourceHash}\nPublic export: ${record.exportHash}\nExact publication commit: ${record.commit}`,
        maintainer_can_modify: false,
      });
    } catch {
      // The response can be lost after creation. The following real listing, never that response, decides recovery.
    }
    matches = await find();
  }
  if (matches.length !== 1) throw new UpdateError("GitHub PR creation/readback is ambiguous; publication retained");
  const number = matches[0]!["number"];
  if (
    !Number.isSafeInteger(number) ||
    Number(number) <= 0 ||
    (record.pullRequest !== undefined && record.pullRequest !== number)
  ) {
    throw new PublicationHold("GitHub PR identity changed");
  }
  record.pullRequest = Number(number);
  save();
  const pr = await process.api(`repos/${repository}/pulls/${number}`);
  if (!object(pr)) throw new UpdateError("GitHub PR readback is incomplete");
  return pr;
}

function pullGate(pr: Record<string, unknown>, record: PublicationRecord, repository: string): Gate | undefined {
  const head = pr["head"];
  const base = pr["base"];
  if (
    pr["state"] !== "open" ||
    pr["draft"] !== false ||
    !object(head) ||
    head["sha"] !== record.commit ||
    !object(head["repo"]) ||
    String(head["repo"]["full_name"]).toLowerCase() !== repository.toLowerCase() ||
    !object(base) ||
    base["sha"] !== record.expectedMain ||
    base["ref"] !== record.ref.slice("refs/heads/".length) ||
    !object(base["repo"]) ||
    String(base["repo"]["full_name"]).toLowerCase() !== repository.toLowerCase()
  )
    return { state: "held", problem: "GitHub PR state/head/base changed; publication held" };
  if (
    !Array.isArray(pr["requested_reviewers"]) ||
    !Array.isArray(pr["requested_teams"]) ||
    pr["requested_reviewers"].length > 0 ||
    pr["requested_teams"].length > 0
  )
    return { state: "held", problem: "GitHub PR requires a reviewer or owner action" };
  return undefined;
}

async function requiredChecks(process: PublicationProcess, repository: string, record: PublicationRecord) {
  const names = new Set(process.config.github!.requiredChecks);
  const bindings = new Map<string, Set<number>>();
  const branch = encodeURIComponent(record.ref.slice("refs/heads/".length));
  const current = await process.api(`repos/${repository}/branches/${branch}`);
  if (!object(current) || !object(current["commit"]) || current["commit"]["sha"] !== record.expectedMain) {
    return { names, bindings, held: "publication main moved while GitHub gates were being read" };
  }
  if (typeof current["protected"] !== "boolean") throw new UpdateError("GitHub branch protection state is incomplete");
  const addChecks = (value: unknown): void => {
    for (const check of rows(value)) {
      if (typeof check["context"] !== "string" || !check["context"]) {
        throw new UpdateError("GitHub required check identity is incomplete");
      }
      names.add(check["context"]);
      const application = check["app_id"] ?? check["integration_id"];
      if (typeof application === "number" && Number.isSafeInteger(application) && application > 0) {
        const required = bindings.get(check["context"]) ?? new Set<number>();
        required.add(application);
        bindings.set(check["context"], required);
      }
    }
  };
  if (current["protected"] === true) {
    const protection = await process.api(`repos/${repository}/branches/${branch}/protection`);
    if (!object(protection)) throw new UpdateError("GitHub branch protection is unreadable");
    const reviews = protection["required_pull_request_reviews"];
    if (
      object(reviews) &&
      (Number(reviews["required_approving_review_count"]) > 0 || reviews["require_code_owner_reviews"] === true)
    ) {
      return { names, bindings, held: "GitHub requires owner/reviewer approval; automatic publication held" };
    }
    const checks = protection["required_status_checks"];
    if (object(checks)) {
      if (Array.isArray(checks["checks"])) addChecks(checks["checks"]);
      if (Array.isArray(checks["contexts"])) {
        for (const name of checks["contexts"]) {
          if (typeof name !== "string" || !name) throw new UpdateError("GitHub required context is invalid");
          names.add(name);
        }
      }
    }
  }
  const rules = rows(await process.api(`repos/${repository}/rules/branches/${branch}`));
  for (const rule of rules) {
    const parameters = rule["parameters"];
    if (rule["type"] === "required_status_checks" && object(parameters))
      addChecks(parameters["required_status_checks"]);
    if (
      rule["type"] === "required_signatures" ||
      rule["type"] === "workflows" ||
      rule["type"] === "update" ||
      (rule["type"] === "pull_request" &&
        object(parameters) &&
        (Number(parameters["required_approving_review_count"]) > 0 || parameters["require_code_owner_review"] === true))
    )
      return { names, bindings, held: "GitHub branch rules require an owner action; automatic publication held" };
  }
  return { names, bindings };
}

/** Every decision is read from GitHub at this exact commit. This function never creates or impersonates CI statuses. */
export async function githubGate(process: PublicationProcess, record: PublicationRecord, save: Save): Promise<Gate> {
  const repository = githubRepository(process.config);
  if (!repository) return { state: "passed" }; // Local Git is the explicit isolated-integration transport.
  const pr = await pullRequest(process, record, repository, save);
  const initialGate = pullGate(pr, record, repository);
  if (initialGate) return initialGate;
  const required = await requiredChecks(process, repository, record);
  if (required.held) return { state: "held", problem: required.held };
  const checkPages = await process.pages(
    `repos/${repository}/commits/${record.commit}/check-runs?per_page=100`,
    "check_runs",
  );
  const statusPages = await process.pages(
    `repos/${repository}/commits/${record.commit}/status?per_page=100`,
    "statuses",
  );
  const evidence = new Map<
    string,
    {
      readonly id: number;
      readonly name: string;
      readonly state: string;
      readonly application: number | null;
    }
  >();
  const remember = (
    kind: string,
    value: Record<string, unknown>,
    name: unknown,
    state: unknown,
    application: number | null = null,
  ): void => {
    if (typeof name !== "string" || typeof state !== "string" || !Number.isSafeInteger(value["id"])) {
      throw new UpdateError("GitHub CI response lacks exact identity/state");
    }
    const key = `${kind}:${name}:${application}`;
    if (Number(value["id"]) > (evidence.get(key)?.id ?? -1)) {
      evidence.set(key, { id: Number(value["id"]), name, state, application });
    }
  };
  for (const page of rows(checkPages)) {
    for (const check of rows(page["check_runs"])) {
      if (check["head_sha"] !== record.commit) throw new PublicationHold("GitHub returned CI for another head");
      const application = check["app"];
      if (!object(application) || !Number.isSafeInteger(application["id"]) || Number(application["id"]) <= 0) {
        throw new UpdateError("GitHub CI application identity is incomplete");
      }
      remember(
        "check",
        check,
        check["name"],
        check["status"] === "completed" ? check["conclusion"] : "pending",
        Number(application["id"]),
      );
    }
  }
  for (const page of rows(statusPages)) {
    if (page["sha"] !== record.commit) throw new PublicationHold("GitHub returned statuses for another head");
    for (const status of rows(page["statuses"])) remember("status", status, status["context"], status["state"]);
  }
  for (const name of required.names) {
    const observed = [...evidence.values()].filter((item) => item.name === name);
    if (!observed.length || observed.some((item) => item.state === "pending")) return { state: "waiting" };
    for (const application of required.bindings.get(name) ?? []) {
      if (!observed.some((item) => item.application === application)) return { state: "waiting" };
    }
    if (observed.some((item) => item.state !== "success")) {
      return { state: "held", problem: "required exact-head GitHub CI did not succeed" };
    }
  }
  const refreshed = await process.api(`repos/${repository}/pulls/${record.pullRequest}`);
  if (!object(refreshed)) throw new UpdateError("GitHub PR readback is incomplete");
  const refreshedGate = pullGate(refreshed, record, repository);
  if (refreshedGate) return refreshedGate;
  if (refreshed["mergeable"] === false || refreshed["mergeable_state"] === "dirty") {
    return { state: "held", problem: "GitHub PR has a merge conflict" };
  }
  if (refreshed["mergeable"] === null || ["unknown", "blocked"].includes(String(refreshed["mergeable_state"])))
    return { state: "waiting" };
  if (
    refreshed["mergeable"] !== true ||
    !["clean", "unstable", "has_hooks"].includes(String(refreshed["mergeable_state"]))
  ) {
    return { state: "held", problem: "GitHub PR is blocked by a merge or approval gate" };
  }
  record.ci = { head: record.commit!, checks: [...required.names].sort(), at: new Date().toISOString() };
  save();
  return { state: "passed" };
}

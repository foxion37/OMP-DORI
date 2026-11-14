import { object } from "../src/update/config.ts";
import type { Distribution } from "./release-build.ts";
import { RELEASE_REPOSITORY, releaseGate } from "./release-gate.ts";
import { ReleaseJournal } from "./release-journal.ts";
import { githubApi, uploadAsset } from "./release-process.ts";
import {
  assets,
  findRelease,
  getRelease,
  marker,
  notes,
  type Release,
  releaseIdentity,
  updateReleaseMetadata,
  validateRelease,
} from "./release-remote.ts";

const PREFIX = `repos/${RELEASE_REPOSITORY}`;

/** The draft body also retains upload/publish intents across fresh workflow runners. */
export async function publishRelease(directory: string, distribution: Distribution): Promise<void> {
  const { manifest, assets: expected } = distribution;
  await releaseGate(manifest);
  const names = Object.keys(expected).sort();
  const body = notes(manifest);
  const journal = new ReleaseJournal(directory, manifest);
  let release = await findRelease(manifest);
  let prepared: string | undefined;
  const readback = async (id: unknown = release?.["id"]): Promise<Release | undefined> => {
    const current = id === undefined ? await findRelease(manifest) : await getRelease(manifest, id);
    if (current) validateRelease(current, manifest, body, names);
    release = current;
    return current;
  };
  if (release) validateRelease(release, manifest, body, names);
  if (journal.pending) {
    const pending = journal.pending;
    if (!release) throw new Error(`Unresolved ${pending}; retain the journal and inspect GitHub before any replay`);
    if (pending === "create") journal.confirmed();
    else if (pending.startsWith("prepare:")) {
      const operation = pending.slice("prepare:".length);
      if (release["draft"] !== true || release["body"] !== marker(body, operation)) {
        throw new Error("Draft intent write is ambiguous; retained without replay");
      }
      prepared = operation;
      journal.confirmed();
    } else if (pending.startsWith("upload:")) {
      if (!(await assets(release, expected)).has(pending.slice("upload:".length))) {
        throw new Error("Asset upload is ambiguous; retained without replay");
      }
      journal.confirmed();
    } else if (pending === "publish" && release["draft"] === false) journal.confirmed();
    else throw new Error(`Unresolved publication intent: ${pending}; inspect GitHub before any replay`);
  }
  if (release?.["draft"] === false) {
    if ((await assets(release, expected)).size !== names.length)
      throw new Error("Published release assets are incomplete");
    return;
  }
  if (!release) {
    if (Number(process.env["GITHUB_RUN_ATTEMPT"] ?? "1") > 1) {
      throw new Error(
        "Fresh workflow retry has no durable draft; use the retained local journal after inspecting GitHub",
      );
    }
    let createdId: number | undefined;
    await journal.effect(
      "create",
      async () => {
        const created = await githubApi(`${PREFIX}/releases`, "POST", {
          ...releaseIdentity(manifest),
          body,
          draft: true,
          make_latest: "false",
        });
        const id = object(created) ? created["id"] : undefined;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("Release ID is invalid");
        createdId = id;
      },
      async () => (await readback(createdId))?.["draft"] === true,
    );
  }
  const prepare = async (operation: string): Promise<void> => {
    if (!release || release["draft"] !== true) throw new Error("Release draft changed before publication intent");
    if (release["body"] === marker(body, operation)) {
      if (prepared !== operation) throw new Error(`Remote ${operation} intent is ambiguous; retained without replay`);
      return;
    }
    await journal.effect(
      `prepare:${operation}`,
      () => updateReleaseMetadata(manifest, Number(release!["id"]), marker(body, operation), true),
      async () => {
        const current = await readback();
        return current?.["draft"] === true && current["body"] === marker(body, operation);
      },
    );
    prepared = operation;
  };
  for (const name of names) {
    if (!release) throw new Error("Release draft is missing");
    const current = await assets(release, expected);
    if (current.has(name)) continue;
    await prepare(`upload:${name}`);
    await journal.effect(
      `upload:${name}`,
      () => uploadAsset(RELEASE_REPOSITORY, Number(release!["id"]), name, expected[name]!),
      async () => {
        const current = await readback();
        return current?.["draft"] === true && (await assets(current, expected)).has(name);
      },
    );
    prepared = undefined;
  }
  if (!release || (await assets(release, expected)).size !== names.length)
    throw new Error("Draft assets are incomplete");
  await releaseGate(manifest);
  await prepare("publish");
  if (!(await readback()) || release!["draft"] !== true || (await assets(release!, expected)).size !== names.length) {
    throw new Error("Verified draft changed before publication");
  }
  await journal.effect(
    "publish",
    () => updateReleaseMetadata(manifest, Number(release!["id"]), body, false),
    async () => {
      const published = await readback();
      return published?.["draft"] === false && (await assets(published, expected)).size === names.length;
    },
  );
}

import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Release } from "../scripts/release-remote.ts";
import { digest } from "../src/update/source.ts";
import { githubFixture } from "./release-producer-setup.ts";

type Options = {
  staleList?: boolean;
  lostCreate?: boolean;
  changedRead?: "id" | "tag" | "commit" | "source";
  corruptUpload?: boolean;
};
type Remote = {
  release?: Release;
  uploads: Record<string, { bytes: string }>;
  creates: number;
  patches: number;
  publishes: number;
  rebindings: number;
  reads: number;
  listsAfterCreate: number;
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Each gh invocation is a separate process over persisted server state. No real gh, network or auth is inherited.
const api = `import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const fixture = JSON.parse(readFileSync("github.json", "utf8"));
const state = JSON.parse(readFileSync("remote.json", "utf8"));
const args = process.argv.slice(2);
const path = args.find(value => value.startsWith("repos/") || value.startsWith("https://uploads.github.com/"));
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const input = args.includes("--input") ? Buffer.from(await Bun.stdin.arrayBuffer()) : undefined;
const send = value => process.stdout.write(JSON.stringify(args.includes("--slurp") ? [value] : value));
const save = () => writeFileSync("remote.json", JSON.stringify(state));
const releasePath = fixture.prefix + "/releases/443";
if (args[0] !== "api" || !path) throw new Error("Unexpected fixture command");
if (method === "GET" && Object.hasOwn(fixture.responses, path)) {
  send(fixture.responses[path]);
} else if (method === "GET" && path === fixture.prefix + "/releases?per_page=100") {
  if (state.release) state.listsAfterCreate++;
  save();
  send(state.release && !fixture.options.staleList ? [state.release] : []);
} else if (method === "POST" && path === fixture.prefix + "/releases") {
  if (state.release) throw new Error("Duplicate release create");
  state.creates++;
  state.release = { ...JSON.parse(input.toString()), id: 443 };
  save();
  if (fixture.options.lostCreate) process.exit(72);
  send(state.release);
} else if (method === "GET" && path === releasePath) {
  if (!state.release) throw new Error("Release not found");
  state.reads++;
  if (state.reads === 1) {
    switch (fixture.options.changedRead) {
      case "id": state.release.id = 444; break;
      case "tag": state.release.tag_name = "untagged-fixture"; break;
      case "commit": state.release.target_commitish = "9".repeat(40); break;
      case "source": state.release.body = state.release.body.replace(fixture.sourceHash, "f".repeat(64)); break;
    }
  }
  save();
  send(state.release);
} else if (method === "PATCH" && path === releasePath) {
  if (!state.release || !state.release.draft) throw new Error("Release is not a writable draft");
  const change = JSON.parse(input.toString());
  state.patches++;
  // Match the observed draft API behavior, including the final draft-to-public PATCH.
  if (!Object.hasOwn(change, "tag_name")) {
    state.release.tag_name = "untagged-fixture";
    state.rebindings++;
  }
  Object.assign(state.release, change);
  if (state.release.draft === false) state.publishes++;
  save();
  send(state.release);
} else if (method === "GET" && path === releasePath + "/assets?per_page=100") {
  send(Object.values(state.uploads));
} else if (method === "POST" && path.startsWith("https://uploads.github.com/")) {
  const url = new URL(path);
  if (url.pathname !== "/" + releasePath + "/assets" || !state.release?.draft) {
    throw new Error("Upload does not address the draft");
  }
  const lengths = args
    .filter((value, index) => args[index - 1] === "-H" && /^Content-Length:/i.test(value))
    .map(value => value.slice("Content-Length:".length).trim());
  if (lengths.length !== 1 || !/^[0-9]+$/.test(lengths[0]) || Number(lengths[0]) !== input?.byteLength) {
    throw new Error("HTTP 400: Bad Content-Length");
  }
  const name = url.searchParams.get("name");
  if (!name || Object.hasOwn(state.uploads, name)) throw new Error("Duplicate or invalid asset upload");
  state.uploads[name] = {
    id: 1000 + Object.keys(state.uploads).length,
    name,
    state: "uploaded",
    size: input.length,
    digest: "sha256:" + createHash("sha256").update(input).digest("hex"),
    bytes: (fixture.options.corruptUpload ? Buffer.from("corrupted remote bytes") : input).toString("base64"),
  };
  save();
  send(state.uploads[name]);
} else if (method === "GET" && path.startsWith(fixture.prefix + "/releases/assets/")) {
  const id = Number(path.slice(path.lastIndexOf("/") + 1));
  const asset = Object.values(state.uploads).find(value => value.id === id);
  if (!asset) throw new Error("Asset not found");
  process.stdout.write(Buffer.from(asset.bytes, "base64"));
} else {
  throw new Error("Unexpected API boundary: " + method + " " + path);
}
`;

export function publisherFixture(options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dori-release-publish-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${api}`, { mode: 0o755 });
  const f = githubFixture();
  const { prefix } = f;
  const archive = Buffer.from("fixture archive");
  const manifest = {
    ...f.manifest,
    archive: { ...f.manifest.archive, sha256: digest(archive), bytes: archive.length },
  };
  const assets: Record<string, Buffer> = {
    [manifest.archive.name]: archive,
    "install.sh": Buffer.from("#!/bin/sh\n"),
    "release-manifest.json": Buffer.from(`${JSON.stringify(manifest)}\n`),
  };
  assets["SHA256SUMS"] = Buffer.from(
    Object.keys(assets)
      .sort()
      .map((name) => `${digest(assets[name]!)}  ${name}\n`)
      .join(""),
  );
  writeFileSync(
    join(directory, "github.json"),
    JSON.stringify({
      prefix,
      options,
      sourceHash: manifest.source.hash,
      responses: {
        ...f.responses,
        [`${prefix}/actions/workflows/50/runs?head_sha=${manifest.commit}&event=push&per_page=100`]: {
          workflow_runs: f.runs,
        },
        [`${prefix}/actions/runs/70/attempts/2/jobs?per_page=100`]: { jobs: f.jobs },
      },
    }),
  );
  writeFileSync(
    join(directory, "remote.json"),
    JSON.stringify({ uploads: {}, creates: 0, patches: 0, publishes: 0, rebindings: 0, reads: 0, listsAfterCreate: 0 }),
  );
  writeFileSync(
    join(directory, "distribution.json"),
    JSON.stringify({
      manifest,
      assets: Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, bytes.toString("base64")])),
    }),
  );
  const publish = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { publishRelease } from ${JSON.stringify(new URL("../scripts/release-publish.ts", import.meta.url).href)};
const distribution = await Bun.file("distribution.json").json();
distribution.assets = Object.fromEntries(Object.entries(distribution.assets).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
await publishRelease(process.cwd(), distribution);`,
      ],
      {
        cwd: directory,
        env: { HOME: directory, PATH: bin, GITHUB_RUN_ATTEMPT: "1" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, err };
  };
  const remote = (): Remote => JSON.parse(readFileSync(join(directory, "remote.json"), "utf8"));
  return { directory, manifest, assets, publish, remote };
}

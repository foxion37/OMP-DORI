import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState, setAutomaticEnabled } from "../src/release/automatic-state.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { supportsReleaseProfile } from "../src/release/manifest.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { portableFixture as fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

const stable = (bundle: VerifiedBundle): VerifiedBundle => ({
  ...bundle,
  manifest: { ...bundle.manifest, prerelease: false },
});
const checkTools = () => {};
const DAY = 86_400_000;

posix.each([false, true])(
  "automatic stable release activation preserves data and retains rollback (side=%s)",
  async (side) => {
    const f = fixture(side);
    const one = await installBundle(f.paths, stable(f.release("one").bundle), undefined);
    const config = readFileSync(f.paths.config);
    writeFileSync(join(f.paths.dori, "auth.json"), "owner auth\n", { mode: 0o600 });
    const candidate = stable(f.release("two").bundle);
    const capabilities = candidate.files.find((file) => file.path === "release-capabilities.json")?.bytes;
    for (const profile of [
      { platform: "linux", arch: "x64", runtime: "herdr" },
      { platform: "darwin", arch: "arm64", runtime: "hc" },
    ])
      expect(supportsReleaseProfile(candidate.manifest, profile, capabilities)).toBe(true);
    let checks = 0;
    const acquire = async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      checks++;
      return candidate;
    };
    const source = await automaticUpdate(f.paths, { now: 10_000, acquire, checkTools });
    expect(source).toBe(releasePath(f.paths, candidate.manifest));
    expect(readlinkSync(f.paths.live)).toBe(source);
    expect(loadInstalled(f.paths)?.previous).toEqual(one.current);
    expect(readFileSync(f.paths.config)).toEqual(config);
    expect(readFileSync(join(f.paths.dori, "auth.json"), "utf8")).toBe("owner auth\n");
    expect(readAutomaticState(f.paths)).toMatchObject({ enabled: true, outcome: "installed", nextCheck: 10_000 + DAY });
    await automaticUpdate(f.paths, { now: 10_000 + DAY - 1, acquire, checkTools });
    expect(checks).toBe(1);
    await automaticUpdate(f.paths, { now: 10_000 + DAY, acquire, checkTools });
    expect(checks).toBe(2);
  },
);

posix("offline attempts back off for a day while the verified installed release stays runnable", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  let attempts = 0;
  const acquire = async (): Promise<VerifiedBundle> => {
    attempts++;
    throw new Error("offline");
  };
  expect(await automaticUpdate(f.paths, { now: 42, acquire, checkTools })).toBe(releasePath(f.paths, one.current));
  expect(readAutomaticState(f.paths)).toMatchObject({ outcome: "failed", detail: "offline", nextCheck: 42 + DAY });
  await automaticUpdate(f.paths, { now: 43, acquire, checkTools });
  expect(attempts).toBe(1);
});

posix("preview and older releases are never automatically selected", async () => {
  for (const kind of ["preview", "older"] as const) {
    const f = fixture();
    const old = stable(f.release("old").bundle);
    const current = stable(f.release("current").bundle);
    const one = await installBundle(f.paths, current, undefined);
    const candidate = kind === "preview" ? f.release("preview").bundle : old;
    expect(await automaticUpdate(f.paths, { now: 42, acquire: async () => candidate, checkTools })).toBe(
      releasePath(f.paths, one.current),
    );
    expect(readAutomaticState(f.paths).outcome).toBe("current");
  }
});

posix("a live lane or Dori session holds automatic activation without signalling it", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const sessions = join(f.paths.dori, "state/sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  saveJson(join(sessions, "lane.json"), { role: "lane", pid: process.pid });
  let calls = 0;
  const acquire = async () => {
    calls++;
    return stable(f.release("two").bundle);
  };
  expect(await automaticUpdate(f.paths, { now: 42, acquire, checkTools })).toBe(releasePath(f.paths, one.current));
  expect(readAutomaticState(f.paths)).toMatchObject({ outcome: "held" });
  expect(calls).toBe(0);
  expect(process.kill(process.pid, 0)).toBe(true);
});

posix("a session appearing during the network check holds activation", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const candidate = stable(f.release("two").bundle);
  const acquire = async () => {
    const directory = join(f.paths.dori, "state/sessions");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    saveJson(join(directory, "lane.json"), { role: "lane", pid: process.pid });
    return candidate;
  };
  expect(await automaticUpdate(f.paths, { now: 42, acquire, checkTools })).toBe(releasePath(f.paths, one.current));
  expect(readAutomaticState(f.paths).outcome).toBe("held");
});

posix("rollback pauses automatic updates until explicitly resumed", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, stable(f.release("one").bundle), undefined);
  const candidate = stable(f.release("two").bundle);
  const two = await installBundle(f.paths, candidate, one);
  await rollbackRelease(f.paths, two);
  expect(readAutomaticState(f.paths)).toMatchObject({ enabled: false, outcome: "rollback" });
  let calls = 0;
  const acquire = async () => {
    calls++;
    return candidate;
  };
  await automaticUpdate(f.paths, { now: DAY, acquire, checkTools });
  expect(calls).toBe(0);
  expect(loadInstalled(f.paths)?.current).toEqual(one.current);
  setAutomaticEnabled(f.paths, true);
  await automaticUpdate(f.paths, { now: DAY, acquire, checkTools });
  expect(calls).toBe(1);
  expect(loadInstalled(f.paths)?.current).toEqual(candidate.manifest);
});

posix.each(["source", "dependency", "metadata"])(
  "tampered %s fails closed even when updates are disabled",
  async (kind) => {
    const f = fixture();
    const one = await installBundle(f.paths, f.release("one").bundle, undefined);
    setAutomaticEnabled(f.paths, false);
    if (kind === "source") {
      const path = join(releasePath(f.paths, one.current), "payload.txt");
      chmodSync(path, 0o600);
      writeFileSync(path, "tampered");
    } else if (kind === "dependency") writeFileSync(join(f.ownedDependency, "index.ts"), "tampered");
    else saveJson(join(f.paths.root, "consumer-automatic.json"), { version: 1, enabled: "no", nextCheck: 0 });
    await expect(
      automaticUpdate(f.paths, {
        now: 42,
        acquire: async () => {
          throw new Error("must not fetch");
        },
        checkTools,
      }),
    ).rejects.toThrow();
  },
);

posix.each(["ulw", "native"])("explicit %s overrides are preserved without an automatic check", async (kind) => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const config = JSON.parse(readFileSync(f.paths.config, "utf8"));
  if (kind === "ulw") config.ompUlwPath = "/owner/ulw/index.ts";
  else config.agentCommand = ["/owner/omp", "--dori-role", "lane"];
  saveJson(f.paths.config, config);
  const bytes = readFileSync(f.paths.config);
  expect(
    await automaticUpdate(f.paths, {
      now: 42,
      acquire: async () => {
        throw new Error("must not fetch");
      },
      checkTools,
    }),
  ).toBe(releasePath(f.paths, one.current));
  expect(readAutomaticState(f.paths).outcome).toBe("held");
  expect(readFileSync(f.paths.config)).toEqual(bytes);
});

posix.each(["OMP_ULW_SRC", "OMP_ULW_REF", "OMP_ULW_REPO", "DORI_OMP", "DORI_AGENT_ARGV", "DORI_OMP_ULW_PATH"])(
  "explicit %s environment selection suppresses automatic updates",
  async (name) => {
    const f = fixture();
    const one = await installBundle(f.paths, f.release("one").bundle, undefined);
    const previous = process.env[name];
    process.env[name] = "/owner/explicit-choice";
    try {
      let requested = false;
      expect(
        await automaticUpdate(f.paths, {
          now: 42,
          acquire: async () => {
            requested = true;
            return f.release("two").bundle;
          },
          checkTools,
        }),
      ).toBe(releasePath(f.paths, one.current));
      expect(requested).toBe(false);
      expect(readAutomaticState(f.paths).outcome).toBe("held");
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  },
);

posix("the activation callback holds a newly prepared release before switching either pointer", async () => {
  const f = fixture();
  const before = await installBundle(f.paths, f.release("one").bundle, undefined);
  const pointer = readlinkSync(f.paths.live);
  await expect(
    installBundle(f.paths, f.release("two").bundle, before, {
      beforeActivate: () => {
        throw new Error("late actor holds activation");
      },
    }),
  ).rejects.toThrow("late actor");
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(loadInstalled(f.paths)).toEqual(before);
});

posix("an older retained physical release stays pinned even beyond the immediate rollback slot", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const two = await installBundle(f.paths, f.release("two").bundle, one);
  await installBundle(f.paths, f.release("three").bundle, two);
  let fetched = false;
  const original = releasePath(f.paths, one.current);
  expect(
    await automaticUpdate(f.paths, {
      source: original,
      acquire: async () => {
        fetched = true;
        return f.release("four").bundle;
      },
      checkTools,
    }),
  ).toBe(original);
  expect(fetched).toBe(false);
});

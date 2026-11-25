import { expect, test } from "bun:test";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { replacePointer, saveJson } from "../../src/release/files.ts";
import { installBundle, rollbackRelease } from "../../src/release/install.ts";
import { prerequisites } from "../../src/release/provision.ts";
import { nativeDirectory } from "../../src/release/native.ts";
import { resolveConsumerOmpCommand } from "../../src/release/runtime.ts";
import { recoverInstalled, releasePath } from "../../src/release/state.ts";
import { fixture } from "../release-consumer-setup.ts";
import { boundRelease } from "../release-native-recovery-setup.ts";
import { isPolicyLaneCommand } from "../../skills/cataly-mode/scripts/src/lane-policy-launch.ts";

// Only the parent test enables this fixture with a real tools-only startup environment.
const tools = process.env["CATALY_TEST_ISOLATED_SOURCE_BUNDLE"];
if (tools !== undefined) {
  // These real Git/receipt fixtures exercise source admission, not a loadable native addon or provider session.
  test("isolated source releases need no stock OMP and bind the native source to the loaded release", async () => {
    expect(process.env["PATH"]).toBe(tools);
    const f = fixture(true);
    const first = boundRelease(f, "first");
    process.env["PATH"] = tools;
    expect(Bun.env["PATH"]).toBe(tools);
    expect(Bun.which("omp")).toBeNull();
    prerequisites();

    const one = await installBundle(f.paths, first.bundle, undefined);
    const sourceOne = releasePath(f.paths, one.current);
    const config = readFileSync(f.paths.config);
    expect(JSON.parse(config.toString()).agentCommand[0]).toBe(join(f.paths.cataly, "bin/omp"));
    expect(lstatSync(join(f.paths.cataly, "bin/omp")).isSymbolicLink()).toBe(false);
    const command = (sourceRoot: string) =>
      resolveConsumerOmpCommand([join(f.paths.cataly, "bin/omp"), "{prompt}"], { home: f.paths.home, sourceRoot });
    expect(command(sourceOne)).toEqual([
      join(sourceOne, "scripts/consumer/omp"),
      "--no-extensions",
      "-e",
      join(sourceOne, "extension"),
      "--config",
      join(f.paths.cataly, "omp.yml"),
      "--config",
      join(f.paths.root, "consumer-discovery", basename(sourceOne), "omp.yml"),
      "{prompt}",
    ]);
    expect(
      isPolicyLaneCommand(
        resolveConsumerOmpCommand(
          [join(f.paths.cataly, "bin/omp"), "--cataly-role", "lane", "{prompt}"],
          { home: f.paths.home, sourceRoot: sourceOne },
        ),
      ),
    ).toBe(true);
    const bound = (sourceRoot: string) => join(nativeDirectory(sourceRoot, f.paths.home), "source/index.ts");
    expect(readFileSync(bound(sourceOne), "utf8")).toContain('selected = "first"');

    const second = boundRelease(f, "second");
    const two = await installBundle(f.paths, second.bundle, one);
    const sourceTwo = releasePath(f.paths, two.current);
    expect(command(sourceOne)[0]).toBe(join(sourceOne, "scripts/consumer/omp"));
    expect(command(sourceTwo)[0]).toBe(join(sourceTwo, "scripts/consumer/omp"));
    expect(readFileSync(bound(sourceTwo), "utf8")).toContain('selected = "second"');
    expect(resolveConsumerOmpCommand(["/owner/custom-omp"], { home: f.paths.home, sourceRoot: sourceTwo })).toEqual([
      "/owner/custom-omp",
    ]);
    expect(await installBundle(f.paths, second.bundle, two)).toEqual(two);
    expect(readFileSync(f.paths.config)).toEqual(config);

    replacePointer(f.paths.live, sourceTwo, sourceOne);
    saveJson(f.paths.state, one);
    saveJson(f.paths.journal, { version: 1, before: one, after: two });
    expect(recoverInstalled(f.paths)).toEqual(one);
    expect(readlinkSync(f.paths.live)).toBe(sourceOne);
    const reactivated = await installBundle(f.paths, second.bundle, one);
    const rolled = await rollbackRelease(f.paths, reactivated);
    expect(rolled.current).toEqual(one.current);
    expect(readFileSync(bound(sourceOne), "utf8")).toContain('selected = "first"');
    expect(readFileSync(f.paths.config)).toEqual(config);

    writeFileSync(bound(sourceTwo), "owner change\n");
    await expect(installBundle(f.paths, second.bundle, rolled)).rejects.toThrow("source checkout differs");
    expect(readlinkSync(f.paths.live)).toBe(sourceOne);
    expect(readFileSync(f.paths.config)).toEqual(config);
    console.log("ISOLATED_RELEASE_OK");
  });
}

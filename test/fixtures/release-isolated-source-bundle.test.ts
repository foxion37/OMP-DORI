import { expect, test } from "bun:test";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { replacePointer, saveJson } from "../../src/release/files.ts";
import { installBundle, rollbackRelease } from "../../src/release/install.ts";
import { prerequisites } from "../../src/release/provision.ts";
import { resolveConsumerOmpCommand, resolveConsumerOmpUlwPath } from "../../src/release/runtime.ts";
import { readSourceBundle } from "../../src/release/source-bundle.ts";
import { recoverInstalled, releasePath } from "../../src/release/state.ts";
import { fixture } from "../release-consumer-setup.ts";
import { boundRelease } from "../release-native-recovery-setup.ts";

// Only the parent test enables this fixture with a real tools-only startup environment.
const tools = process.env["DORI_TEST_ISOLATED_SOURCE_BUNDLE"];
if (tools !== undefined) {
  // These real Git/receipt fixtures exercise source admission, not a loadable native addon or provider session.
  test("isolated source releases need no stock OMP and bind both native and ULW defaults to the loaded release", async () => {
    expect(process.env["PATH"]).toBe(tools);
    const f = fixture(true);
    const first = boundRelease(f, "first");
    // The shared side-home fixture temporarily adds a legacy OMP for independent-native tests.
    process.env["PATH"] = tools;
    expect(Bun.env["PATH"]).toBe(tools);
    expect(Bun.which("omp")).toBeNull();
    const runtime = process.platform === "darwin" ? "hc" : "herdr";
    expect(Bun.which(runtime)).toBe(join(tools, runtime));
    prerequisites(runtime, true, false, f.paths);

    const one = await installBundle(f.paths, first.bundle, undefined);
    const sourceOne = releasePath(f.paths, one.current);
    const config = readFileSync(f.paths.config);
    const receipt = join(f.paths.manifests, `${basename(sourceOne)}.json`);
    const metadata = readFileSync(receipt);
    saveJson(receipt, { ...one.current, requirements: { ...one.current.requirements, omp: "18.18.8" } });
    const inconsistent = Bun.spawnSync(["/bin/bash", join(f.paths.dori, "bin/omp"), "--version"], {
      env: { HOME: f.paths.home, PATH: tools },
    });
    expect(inconsistent.exitCode).not.toBe(0);
    expect(inconsistent.stderr.toString()).toContain("Unsupported or inconsistent consumer native protocol");
    expect(inconsistent.stdout.toString()).toBe("");
    writeFileSync(receipt, metadata);
    expect(JSON.parse(config.toString()).agentCommand[0]).toBe(join(f.paths.dori, "bin/omp"));
    expect(lstatSync(join(f.paths.dori, "bin/omp")).isSymbolicLink()).toBe(false);
    const command = (sourceRoot: string) =>
      resolveConsumerOmpCommand([join(f.paths.dori, "bin/omp"), "{prompt}"], { home: f.paths.home, sourceRoot });
    expect(command(sourceOne)).toEqual([
      join(sourceOne, "scripts/consumer/omp"),
      "--no-extensions",
      "-e",
      join(sourceOne, "extension"),
      "--config",
      join(f.paths.dori, "omp.yml"),
      "--config",
      join(f.paths.root, "consumer-discovery", basename(sourceOne), "omp.yml"),
      "{prompt}",
    ]);
    const dependency = (sourceRoot: string) => {
      const { lock, identity } = readSourceBundle(sourceRoot);
      return join(f.paths.dependencies, `omp-ulw-${lock.commit}-${identity}`, "index.ts");
    };
    const effective = (sourceRoot: string) =>
      resolveConsumerOmpUlwPath("", { home: f.paths.home, sourceRoot, useDefault: true });
    const firstUlw = effective(sourceOne);
    expect(firstUlw).toBe(dependency(sourceOne));
    expect(readFileSync(firstUlw, "utf8")).toContain('selected = "first"');

    const second = boundRelease(f, "second", first.source);
    const two = await installBundle(f.paths, second.bundle, one);
    const sourceTwo = releasePath(f.paths, two.current);
    expect(command(sourceOne)[0]).toBe(join(sourceOne, "scripts/consumer/omp"));
    expect(command(sourceTwo)[0]).toBe(join(sourceTwo, "scripts/consumer/omp"));
    const secondUlw = effective(sourceTwo);
    expect(secondUlw).toBe(dependency(sourceTwo));
    expect(readFileSync(secondUlw, "utf8")).toContain('selected = "second"');
    expect(resolveConsumerOmpCommand(["/owner/custom-omp"], { home: f.paths.home, sourceRoot: sourceTwo })).toEqual([
      "/owner/custom-omp",
    ]);
    expect(resolveConsumerOmpUlwPath("/owner/custom-ulw/index.ts", { home: f.paths.home, sourceRoot: sourceTwo })).toBe(
      "/owner/custom-ulw/index.ts",
    );
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
    expect(effective(sourceOne)).toBe(dependency(sourceOne));
    expect(readFileSync(f.paths.config)).toEqual(config);

    writeFileSync(effective(sourceTwo), "owner change\n");
    expect(() => effective(sourceTwo)).toThrow();
    await expect(installBundle(f.paths, second.bundle, rolled)).rejects.toThrow();
    expect(readlinkSync(f.paths.live)).toBe(sourceOne);
    expect(readFileSync(f.paths.config)).toEqual(config);
    console.log("ISOLATED_RELEASE_OK");
  });
}

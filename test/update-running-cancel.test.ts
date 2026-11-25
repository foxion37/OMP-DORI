import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectActiveDeployment, saveActiveDeployment } from "../src/update/deployment-active.ts";
import { captureRuntime, startHarness } from "../src/update/deployment-harness.ts";
import { leadRuntimeHealth } from "../src/update/deployment-monitor-receipts.ts";
import { processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import type { ToolchainReceipt } from "../src/update/deployment-types.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { fixtureGit, nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";
import { desiredPath } from "./update-deploy-headless-lead.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";
import { waitFor } from "./update-detection-setup.ts";

test.skipIf(process.platform !== "linux")(
  "abort stops the active native source Git verification group, not the native runtime",
  async () => {
    const f = await headlessDeployment({ start: false });
    try {
      // The running release is bound to a native source cache in the deployment home.
      const native = overlayFixture(
        f.oldSource,
        join(f.root, "native-upstream"),
        "reviewed",
        f.toolchain.nativeVersion,
      );
      const receipt = nativeCacheFixture(f.oldSource, f.config.home, native.checkout);
      // A native lead is Bun running the cache's CLI entry behind the source launcher's preload, so its argv names that
      // entry. Here the preload starts the fake host and the entry path resolves to the cache's own file.
      const launch = join(f.root, "launch/packages/coding-agent");
      mkdirSync(join(launch, "scripts"), { recursive: true });
      mkdirSync(join(launch, "src"));
      symlinkSync(receipt.entry, join(launch, "src/cli.ts"));
      const settings = JSON.parse(readFileSync(f.config.catalyConfig, "utf8"));
      const [omp, ...rest] = settings.agentCommand as string[];
      writeFileSync(join(launch, "scripts/omp.ts"), `await import(${JSON.stringify(omp)});\n`);
      const agentCommand = [process.execPath, "--preload", join(launch, "scripts/omp.ts"), join(launch, "src/cli.ts")];
      writeFileSync(f.config.catalyConfig, JSON.stringify({ ...settings, agentCommand: [...agentCommand, ...rest] }));
      await startHarness(f.config, f.oldSource, { ...f.toolchain, extensionSource: f.oldSource }, f.work);
      await f.until(async () => {
        const seen = await f.lead();
        return seen?.status === "idle" && existsSync(desiredPath(f.config, seen.sessionId!)) ? seen : undefined;
      }, "an idle lead with its desired monitors");
      const runtime = await captureRuntime(f.config, true);
      await waitFor(() => leadRuntimeHealth(f.config.stateDir, runtime) !== undefined);
      // The receipt preparation records for a release bound to that cache.
      const toolchain: ToolchainReceipt = {
        omp: receipt.omp,
        bun: f.toolchain.bun,
        nativeVersion: f.toolchain.nativeVersion,
        ompEntry: receipt.omp,
        ompEntryHash: digest(readFileSync(receipt.omp)),
        bunHash: f.toolchain.bunHash,
        nativeConfig: f.toolchain.nativeConfig,
        nativeConfigHash: f.toolchain.nativeConfigHash,
        nativeSource: receipt,
        extensionSource: f.oldSource,
      };
      saveActiveDeployment(f.config, {
        ...f.record,
        runtime,
        sourceHash: sourceManifest(f.oldSource).hash,
        toolchain,
      });
      // Without a hold, status verifies the whole native source checkout and reports the running revision.
      expect(await inspectActiveDeployment(f.config)).toMatchObject({
        status: "running",
        source: f.oldSource,
        nativeBundleIdentity: receipt.identity,
      });

      const marker = join(f.root, "filter-pid");
      const filter = join(f.root, "filter.ts");
      // A real Git filter holds its OS pipe; fake timers cannot expose a blocked synchronous parent.
      writeFileSync(
        filter,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
await Bun.sleep(1_000);
process.stdout.write(await Bun.stdin.text());
`,
      );
      const checkout = join(receipt.directory, "source");
      fixtureGit(
        checkout,
        "config",
        "filter.hold.clean",
        `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`,
      );
      fixtureGit(checkout, "config", "filter.hold.required", "true");
      writeFileSync(join(checkout, ".git/info/attributes"), "index.ts filter=hold\n");
      const active = join(f.config.releaseRoot, "active.json");
      const before = readFileSync(active, "utf8");
      const abort = new AbortController();
      const previousTemp = process.env["TMPDIR"];
      process.env["TMPDIR"] = f.root;
      const pending = inspectActiveDeployment(f.config, abort.signal);
      try {
        await waitFor(() => existsSync(marker));
        expect(readdirSync(f.root).filter((name) => name.startsWith("cataly-status-"))).toHaveLength(1);
        const pid = Number(readFileSync(marker, "utf8"));
        abort.abort();
        const result = await pending;
        expect(result.status).toBe("unknown");
        expect(result).not.toHaveProperty("sourceHash");
        expect(processIdentity(pid)).toBeUndefined();
        expect(readdirSync(f.root).filter((name) => name.startsWith("cataly-status-"))).toHaveLength(0);
        expect(readFileSync(active, "utf8")).toBe(before);
        expect(sameProcess(runtime)).toBe(true);
        expect((await f.lead())?.pid).toBe(runtime.pid);
      } finally {
        abort.abort();
        await pending;
        if (previousTemp === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = previousTemp;
      }
    } finally {
      await f.teardown();
    }
  },
  30_000,
);

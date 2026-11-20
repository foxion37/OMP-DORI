import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function assertNativeHost(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const host = env["DORI_TEST_OMP_ROOT"];
  if (!host || !isAbsolute(host)) throw new Error("DORI_TEST_OMP_ROOT must name the absolute exact native OMP fixture");
  const manifest = await Bun.file(join(host, "package.json")).json();
  if (manifest.version !== "18.20.0") throw new Error(`native OMP fixture must be 18.20.0, got ${manifest.version}`);
  for (const [specifier, path] of [
    ["@oh-my-pi/pi-coding-agent/extensibility/extensions/runner", "src/extensibility/extensions/runner.ts"],
    ["@oh-my-pi/pi-coding-agent/extensibility/extensions/loader", "src/extensibility/extensions/loader.ts"],
    ["@oh-my-pi/pi-coding-agent/config/settings", "src/config/settings.ts"],
  ] as const) {
    const resolved = import.meta.resolve(specifier);
    const modulePath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    if (realpathSync(modulePath) !== realpathSync(join(host, path)))
      throw new Error(`native prompt guard imported ${specifier} outside DORI_TEST_OMP_ROOT`);
  }
}

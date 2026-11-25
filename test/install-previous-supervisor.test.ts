import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "./install-setup.ts";

// Linux-only: the bridge reads each supervisor's exact argument vector from the process table.
const linux = test.skipIf(process.platform !== "linux");

/** A previous main's controller: the source tree whose overlay lock this version removed. */
function previousController(home: string): string {
  const tree = join(home, "old-controller");
  mkdirSync(join(tree, "skills/cataly-mode/scripts/src"), { recursive: true });
  writeFileSync(join(tree, "omp-ulw.overlay.lock"), "{}\n");
  writeFileSync(join(tree, "skills/cataly-mode/scripts/src/cli.ts"), "export {};\n");
  return tree;
}

/** A running update supervisor, exactly as a service manager starts it. */
function supervisor(home: string, controller: string, mode: string): { pid: number; kill: () => void } {
  const config = join(home, ".cataly/source-update.json");
  mkdirSync(join(home, ".cataly"), { recursive: true });
  writeFileSync(config, "{}\n");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
      join(home, "scripts/update-supervisor.ts"),
      "--config",
      config,
      "--controller",
      controller,
      "--bun",
      process.execPath,
      "--mode",
      mode,
    ],
    { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" },
  );
  return { pid: child.pid, kill: () => child.kill() };
}

linux("a source supervisor on the previous controller is handed to this version's controller", async () => {
  const s = setup();
  const record = join(s.root, "apply.log");
  // The installed skill CLI stands in for this version's controller: it records its exact arguments and completes
  // the deployment by switching the controller link.
  const overlay = join(s.home, "old-controller/omp-ulw.overlay.lock");
  s.upstreamCommit(
    `import { appendFileSync, rmSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `rmSync(${JSON.stringify(overlay)}, { force: true });\n`,
  );
  const controller = previousController(s.home);
  const running = supervisor(s.home, controller, "source");
  try {
    const r = s.install();
    expect(r.code, r.err).toBe(0);
    const calls = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["update", "source", "apply", "--when", "idle", "--config", join(s.home, ".cataly/source-update.json")],
    ]);
    expect(r.err).toContain(`Handing the managed deployment of ${join(s.home, ".cataly/source-update.json")}`);
    expect(r.err).toContain(`Moved the managed deployment of ${join(s.home, ".cataly/source-update.json")}`);
    expect(existsSync(overlay)).toBe(false);
  } finally {
    running.kill();
    rmSync(join(s.home, "old-controller"), { recursive: true, force: true });
  }
});

linux("an upstream supervisor is told when its move completes, and no model work starts", async () => {
  const s = setup();
  const record = join(s.root, "apply.log");
  s.upstreamCommit(
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
  );
  const controller = previousController(s.home);
  const running = supervisor(s.home, controller, "upstream");
  try {
    const r = s.install();
    expect(r.code, r.err).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(r.err).toContain(
      `The managed deployment of ${join(s.home, ".cataly/source-update.json")} (supervisor ${running.pid}) still runs the previous controller; the move completes when its next deployment runs this version`,
    );
  } finally {
    running.kill();
    rmSync(join(s.home, "old-controller"), { recursive: true, force: true });
  }
});

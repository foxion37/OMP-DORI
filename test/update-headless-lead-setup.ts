import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HeadlessRuntime } from "../src/runtime/headless.ts";
import { writePrivate } from "../src/runtime/headless-record.ts";
import type { DeploymentConfig } from "../src/update/deployment-types.ts";

const fakeHost = resolve(import.meta.dir, "fixtures/headless-rpc.ts");
export const repoCli = resolve(import.meta.dir, "../src/cli.ts");

/**
 * A release whose `src/cli.ts` runs this checkout's CLI, so `cataly up|stop` behave exactly as shipped. It carries this
 * checkout's own native source bundle, whose locked version the fake OMP reports.
 */
export function release(dir: string, generation: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "extension"), { recursive: true });
  writeFileSync(
    join(dir, "src/cli.ts"),
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(repoCli)}, ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
});
process.exit(await child.exited);
`,
  );
  writeFileSync(join(dir, "extension/index.ts"), `export const generation = ${JSON.stringify(generation)};\n`);
  for (const name of ["native-omp.lock", "native-omp.patch"])
    copyFileSync(resolve(import.meta.dir, "..", name), join(dir, name));
}

/** Poll a native observation until it yields a value; observation errors count as not yet. */
export async function until<T>(read: () => Promise<T | undefined>, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  do {
    const seen = await read().catch(() => undefined);
    if (seen !== undefined) return seen;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`native harness did not reach: ${what}`);
}

/**
 * A lead-only native harness for one deployment config: a real headless reservation whose OMP is the fake host, bound
 * in `harness-native.json` exactly as `cataly up` binds its lead. `prelude` runs inside the lead's own process before
 * the host starts, so whatever it spawns is a real descendant of the lead.
 */
export async function headlessLead(config: DeploymentConfig, dir: string, prelude = "") {
  for (const path of [config.stateDir, config.catalyHome, dir]) mkdirSync(path, { recursive: true });
  const omp = join(dir, "lead-omp");
  // The runtime first launches the lead once with `--version`; only the real launch runs the prelude.
  const guarded = `if (!process.argv.includes("--version")) {\n${prelude}\n}`;
  writeFileSync(omp, `#!${process.execPath}\n${guarded}\nawait import(${JSON.stringify(fakeHost)});\n`, {
    mode: 0o700,
  });
  const env = {
    HOME: config.home,
    PATH: "/usr/bin:/bin",
    CATALY_TEST_SESSION: join(dir, "lead-session.jsonl"),
    CATALY_TEST_TRACE: join(dir, "lead-trace.jsonl"),
    CATALY_TEST_BACKGROUND_DONE: join(dir, "background-done"),
  };
  const rt = new HeadlessRuntime(config.stateDir, env);
  const ref = await rt.create({ name: "lead", role: "lead", cwd: config.home, env });
  const started = await rt.startNative(ref, [omp, "--cataly-role", "cataly"], env);
  const sessionId = started.sessionId;
  if (!sessionId || started.pid === undefined) throw new Error("fixture lead did not bind a native session");
  const inventory = join(config.catalyHome, "harness-native.json");
  writePrivate(inventory, { version: 1, stateDir: config.stateDir, roles: { lead: { ref, sessionId } } });
  const observe = () => rt.observe(ref);
  const background = env.CATALY_TEST_BACKGROUND_DONE;
  const idle = () => until(async () => ((await observe()).status === "idle" ? true : undefined), "an idle lead", 5_000);
  await idle();
  return {
    rt,
    ref,
    sessionId,
    pid: started.pid,
    inventory,
    observe,
    /** "background job" keeps the fake host working until close; "request approval" opens an approval dialog. */
    deliver: async (text: string): Promise<void> => {
      const outcome = await rt.deliver(ref, text, { expectedSessionId: sessionId });
      if (outcome.kind !== "delivered") throw new Error(`fixture lead refused delivery: ${outcome.kind}`);
    },
    /** Settle any dialog or turn, then stop the lead through its own idle-only harness role stop. */
    close: async (): Promise<void> => {
      const seen = await observe().catch(() => undefined);
      if (seen && seen.status !== "gone") {
        for (const dialog of seen.dialogs)
          await rt.answer(ref, dialog.id, { cancelled: true }, sessionId).catch(() => undefined);
        writeFileSync(background, "");
        await idle().catch(() => undefined);
        await rt.stopHarnessRole(ref, "lead", sessionId).catch(() => undefined);
      }
      try {
        process.kill(started.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}

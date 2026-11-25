import { expect, test } from "bun:test";
import { join } from "node:path";
import { RESUME_SESSION_ENV } from "../src/harness-native-resume.ts";
import { actorEnv, managedOmpCommand } from "../src/update/deployment-process.ts";
import { headlessDeployment } from "./update-deploy-headless-setup.ts";

// The headless harness needs a Unix socket and the process readers that bind its identity.
const native = test.skipIf(process.platform !== "linux");

type Fixture = Awaited<ReturnType<typeof headlessDeployment>>;

/** The installed release's own `cataly harness <args>`, exactly as the managed controller runs it. */
async function harness(f: Fixture, args: readonly string[], extra: Record<string, string> = {}) {
  const toolchain = { ...f.toolchain, extensionSource: f.oldSource };
  const env = {
    ...actorEnv(f.config, toolchain),
    CATALY_AGENT_ARGV: JSON.stringify(managedOmpCommand(toolchain, f.oldSource)),
    ...extra,
  };
  const proc = Bun.spawn([process.execPath, join(f.oldSource, "src/cli.ts"), ...args], {
    cwd: f.work,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

const idleLead = (f: Fixture) =>
  f.until(async () => {
    const seen = await f.lead();
    return seen?.status === "idle" ? seen : undefined;
  }, "an idle lead");

native(
  "harness stop and up resume the cleanly stopped lead session; --fresh starts a new one",
  async () => {
    const f = await headlessDeployment();
    try {
      const first = await idleLead(f);
      expect(await harness(f, ["stop"])).toMatchObject({ code: 0 });
      const resumed = await harness(f, ["up", "--cwd", f.work]);
      expect(resumed).toMatchObject({ code: 0 });
      expect(resumed.out).toContain(`resumed=${first.sessionId}`);
      const second = await idleLead(f);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.sessionFile).toBe(first.sessionFile);
      expect(second.pid).not.toBe(first.pid);
      expect(second.ref.id).not.toBe(first.ref.id);
      expect(f.inventory()!.roles["lead"]).toMatchObject({ sessionId: first.sessionId });

      expect(await harness(f, ["stop"])).toMatchObject({ code: 0 });
      // A managed restart that names another session refuses rather than starting any lead.
      const refused = await harness(f, ["up", "--cwd", f.work], { [RESUME_SESSION_ENV]: "other-session" });
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("cannot resume the required lead session other-session");
      expect(f.inventory()).toBeUndefined();
      expect(await harness(f, ["up", "--fresh"], { [RESUME_SESSION_ENV]: first.sessionId! })).toMatchObject({
        code: 2,
      });

      const fresh = await harness(f, ["up", "--cwd", f.work, "--fresh"]);
      expect(fresh).toMatchObject({ code: 0 });
      expect(fresh.out).not.toContain("resumed=");
      const third = await idleLead(f);
      expect(third.sessionId).not.toBe(first.sessionId);
      expect(third.sessionFile).not.toBe(first.sessionFile);

      // The fresh lead is now the last one: the next plain up resumes it, never the older session.
      expect(await harness(f, ["stop"])).toMatchObject({ code: 0 });
      expect(await harness(f, ["up", "--cwd", f.work])).toMatchObject({ code: 0 });
      expect((await idleLead(f)).sessionId).toBe(third.sessionId);
    } finally {
      await f.teardown();
    }
  },
  180_000,
);

native(
  "a lead that exited on its own is not resumed by the next up",
  async () => {
    const f = await headlessDeployment();
    try {
      const first = await idleLead(f);
      process.kill(first.pid, "SIGKILL");
      await f.until(async () => ((await f.rt.observe(first.ref)).status === "gone" ? true : undefined), "a gone lead");
      expect(await harness(f, ["stop"])).toMatchObject({ code: 0 });
      const up = await harness(f, ["up", "--cwd", f.work]);
      expect(up).toMatchObject({ code: 0 });
      expect(up.out).not.toContain("resumed=");
      expect((await idleLead(f)).sessionId).not.toBe(first.sessionId);
    } finally {
      await f.teardown();
    }
  },
  120_000,
);

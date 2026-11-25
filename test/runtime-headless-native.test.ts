import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Registry } from "../skills/cataly-mode/scripts/src/registry.ts";
import { HeadlessRuntime, type HeadlessObservation } from "../src/runtime/headless.ts";
import { installNativeHost } from "./fixtures/native-host.ts";

const native = process.env["CATALY_TEST_OMP_ROOT"];
const executable = process.env["CATALY_TEST_OMP_EXEC"];
const runSmoke = process.env["CATALY_HEADLESS_SMOKE"] === "1" && process.platform !== "win32";
const cli = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");

async function runCli(env: Record<string, string>, ...args: string[]): Promise<string> {
  const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 35_000 });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`cataly ${args[0]} exited ${code}: ${err || out}`);
  return out.trim();
}

// Exact, unmocked OMP and the Cataly extension; only the model provider is a localhost fixture.
test.skipIf(!runSmoke)(
  "CLI launches, reports, pauses, resumes and closes a native lane without a terminal runtime",
  async () => {
    const ompArgv = executable ? [executable] : native ? [process.execPath, join(native, "dist", "cli.js")] : undefined;
    if (!ompArgv) throw new Error("Set CATALY_TEST_OMP_ROOT or CATALY_TEST_OMP_EXEC to the pinned OMP host");
    const home = realpathSync(mkdtempSync("/tmp/cataly-headless-native-"));
    const cwd = join(home, "work");
    const stateDir = join(home, "state");
    const ompDir = join(home, "omp");
    const bin = join(home, "bin");
    mkdirSync(cwd);
    mkdirSync(ompDir);
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    // The CLI finds the Rust host where an installation keeps it, as a consumer's would.
    const installed = installNativeHost(home);
    const config = join(home, "config.json");
    const key = "native-smoke";
    const wrong = `${key}-mismatch`;
    let submissions = 0;
    const marker = "CATALY_HEADLESS_LOCAL_GOAL";
    const reply = "CATALY_HEADLESS_LOCAL_ANSWER";
    const remoteText = "Headless remote literal: $HOME $(false) 'exact'\nsecond line";
    const remoteReply = "CATALY_HEADLESS_EXACT_REMOTE_ACCEPTED";
    const brief = join(cwd, `${marker}.txt`);
    const evidence = join(cwd, `${marker}-evidence.txt`);
    writeFileSync(brief, "A no-side-effects localhost smoke test.");
    writeFileSync(evidence, "smoke done signal");
    const configure = (modelArg: string) =>
      writeFileSync(
        config,
        JSON.stringify({
          stateDir,
          defaultCwd: cwd,
          sessionsDir: join(ompDir, "sessions"),
          requireModelReadback: true,
          guard: { panesMax: 1, memFreeMinPct: 0, diskFreeMinGb: 0 },
          defaultModel: "cataly-local/headless-fixture",
          agentCommand: [
            ...ompArgv,
            "--no-extensions",
            "-e",
            resolve(import.meta.dir, "../extension/index.ts"),
            "--model",
            modelArg,
            "--thinking",
            "off",
            "{prompt}",
          ],
        }),
      );
    configure("{model}");
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        submissions++;
        const body = await request.text();
        const exactRemote = body.includes(JSON.stringify(remoteText).slice(1, -1));
        if (!body.includes(marker) && !exactRemote)
          return new Response("unexpected local fixture input", { status: 400 });
        const frame = {
          id: "headless-local-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "headless-fixture",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: exactRemote ? remoteReply : reply },
              finish_reason: "stop",
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    writeFileSync(
      join(ompDir, "models.yml"),
      JSON.stringify({
        providers: {
          "cataly-local": {
            baseUrl: `${provider.url.origin}/v1`,
            apiKey: "local-fixture-only",
            api: "openai-completions",
            models: [
              { id: "headless-fixture", name: "Headless loopback fixture" },
              { id: "alternate", name: "Alternate loopback fixture" },
            ],
          },
        },
      }),
    );
    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "xdg-state"),
      XDG_CACHE_HOME: join(home, "cache"),
      PI_CODING_AGENT_DIR: ompDir,
      CATALY_HOME: home,
      CATALY_CONFIG: config,
      CATALY_STATE_DIR: stateDir,
      NO_PROXY: "127.0.0.1",
    };
    const rt = new HeadlessRuntime(stateDir, env);
    const registry = new Registry(stateDir);
    const queued = `${key}-queued`;
    try {
      expect(Bun.which("tern", { PATH: env.PATH })).toBeNull();
      const launch = ["launch", key, "--title", "Live test", "--brief", brief, "--done", `file ${evidence}`];
      await expect(runCli({ ...env, CATALY_LANE_RUNTIME: "terminal" }, ...launch)).rejects.toThrow(
        "tern is not on PATH",
      );
      expect(await registry.read(key)).toBeNull();
      const launched = await runCli(env, ...launch);
      expect(launched).toInclude(`STARTUP_OK ${key} headless:`);
      const lane = await registry.read(key);
      const ref = lane?.sessionRef;
      const sessionId = lane?.session;
      if (!ref || !sessionId) throw new Error("native startup did not attest the registered session");
      // The CLI hosted the lane with the installed native binary, not a Bun broker.
      const hostDir = join(stateDir, "headless", ref.id);
      const { pid } = JSON.parse(readFileSync(join(hostDir, "endpoint.json"), "utf8")) as { pid: number };
      const hostArgs = Bun.spawnSync(["ps", "-ww", "-o", "args=", "-p", String(pid)])
        .stdout.toString()
        .trim();
      expect(hostArgs).toBe(`${installed} headless-host ${hostDir}`);
      const observe = async (laneKey = key) =>
        JSON.parse(await runCli(env, "headless", "observe", laneKey)) as HeadlessObservation;
      const waitForReply = async (expected: string, laneKey = key) => {
        const deadline = Date.now() + 12_000;
        let observed = await observe(laneKey);
        while (
          (!observed.recent.some((entry) => entry.text === expected) || observed.status !== "idle") &&
          Date.now() < deadline
        ) {
          await Bun.sleep(100);
          observed = await observe(laneKey);
        }
        expect(observed.recent).toContainEqual({ kind: "assistant", text: expected });
        return observed;
      };
      const observed = await waitForReply(reply);
      expect(observed).toMatchObject({ role: "lane", sessionId, goal: { status: "active" }, held: false });
      expect(submissions).toBe(1);
      await expect(runCli(env, "can-launch")).rejects.toThrow("panes 1 >= 1");
      const laneStatus = async () => JSON.parse(await runCli(env, "status", key, "--json")).lanes[0];
      expect(await laneStatus()).toMatchObject({ key, status: "working", runtime: { goal: { status: "active" } } });
      expect(JSON.parse(await runCli(env, "remote", "sessions"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ session: sessionId, pane: `headless:${ref.id}`, lane: key }),
        ]),
      );
      expect(
        JSON.parse(await runCli(env, "remote", "model", sessionId, "--model", "cataly-local/alternate")),
      ).toMatchObject({ status: "changed", model: "cataly-local/alternate", session: sessionId });
      const remoteArgs = ["remote", "send", sessionId, "--id", "native-smoke-send", "--text", remoteText];
      const admitted = JSON.parse(await runCli(env, ...remoteArgs));
      expect(admitted).toMatchObject({ status: "admitted", replyAttributed: false, session: sessionId });
      expect(JSON.parse(await runCli(env, ...remoteArgs))).toEqual(admitted);
      expect(JSON.parse(await runCli(env, "remote", "receipt", sessionId, "--id", "native-smoke-send"))).toMatchObject({
        status: "admitted",
        id: "native-smoke-send",
        replyAttributed: false,
      });
      expect((await waitForReply(remoteReply)).model).toBe("cataly-local/alternate");
      const report = JSON.parse(
        await runCli(env, "report", key, "--kind", "milestone", "--text", "verified localhost", "--json"),
      );
      expect(report).toMatchObject({ generation: ref.id, text: "verified localhost" });
      expect(await runCli(env, "pause", key)).toStartWith(`PAUSED ${key}`);
      expect(await observe()).toMatchObject({
        sessionId,
        status: "idle",
        goal: { status: "paused" },
        held: false,
      });
      expect(await rt.deliver(ref, "must not wake a paused lane")).toMatchObject({ kind: "not-ready" });
      expect(await laneStatus()).toMatchObject({ key, status: "paused", runtime: { goal: { status: "paused" } } });
      expect(await runCli(env, "resume", key)).toStartWith(`RESUMED ${key}`);
      expect(await observe()).toMatchObject({ sessionId, pid: observed.pid, goal: { status: "active" } });
      expect(await runCli(env, "close", key)).toInclude(`CLOSED ${key}`);
      expect(await observe()).toMatchObject({ status: "gone" });
      expect(await laneStatus()).toMatchObject({ key, status: "closed", runtime: null });

      expect(await runCli(env, "launch", queued, ...launch.slice(2), "--after", key)).toStartWith("QUEUED");
      expect(await runCli(env, "queue", "start", queued)).toContain(`STARTUP_OK ${queued} headless:`);
      await waitForReply(reply, queued);
      expect(await runCli(env, "close", queued)).toContain(`CLOSED ${queued}`);

      // A fixed model in an operator's command must not silently override this lane's requested model.
      configure("cataly-local/headless-fixture");
      const prior = submissions;
      await expect(
        runCli(env, "launch", wrong, ...launch.slice(2), "--model", "cataly-local/alternate"),
      ).rejects.toThrow("STARTUP_MODEL_HOLD");
      expect(submissions).toBe(prior);
      const held = await registry.read(wrong);
      if (!held?.sessionRef || !held.session) throw new Error("model mismatch lost the native session binding");
      expect(await rt.observe(held.sessionRef)).toMatchObject({ sessionId: held.session, goal: { status: "none" } });
    } finally {
      try {
        for (const laneKey of [key, wrong, queued]) {
          const lane = await registry.read(laneKey);
          if (lane?.sessionRef && lane.session && (await rt.observe(lane.sessionRef)).status !== "gone")
            await rt.remoteClose(lane.sessionRef, lane.session, true);
        }
      } finally {
        await provider.stop(true);
        rmSync(home, { force: true, recursive: true });
      }
    }
  },
  40_000,
);

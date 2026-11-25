import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HeadlessRuntime, type HeadlessObservation } from "../src/runtime/headless.ts";
import { Store } from "../src/store.ts";
import { installNativeHost } from "./fixtures/native-host.ts";

const enabled = process.env["CATALY_HEADLESS_SMOKE"] === "1" && process.platform !== "win32";
const cli = resolve(import.meta.dir, "../src/cli.ts");
const marker = "CATALY_HARNESS_BUSY_PROBE";
const reply = "CATALY_HARNESS_LOCAL_OK";

async function run(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 70_000 });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  do {
    const seen = await read();
    if (seen !== undefined) return seen;
    await Bun.sleep(60);
  } while (Date.now() < deadline);
  throw new Error("native harness did not produce the expected observation");
}

test.skipIf(!enabled)(
  "root CLI starts, observes and stops pinned OMP roles and plain native loops without a terminal",
  async () => {
    const executable = process.env["CATALY_TEST_OMP_EXEC"];
    const host = process.env["CATALY_TEST_OMP_ROOT"];
    const omp = executable ? [executable] : host ? [process.execPath, join(host, "dist", "cli.js")] : undefined;
    if (!omp) throw new Error("set CATALY_TEST_OMP_EXEC or CATALY_TEST_OMP_ROOT to the bound native OMP");
    const home = realpathSync(mkdtempSync("/tmp/cataly-native-harness-"));
    const stateDir = join(home, "state");
    const cwd = join(home, "work");
    const ompDir = join(home, "omp");
    const bin = join(home, "bin");
    const config = join(home, "config.json");
    const brief = join(cwd, "brief.txt");
    const evidence = join(cwd, "evidence.txt");
    mkdirSync(cwd);
    mkdirSync(ompDir);
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    // The CLI finds the Rust host where an installation keeps it, as a consumer's would.
    installNativeHost(home);
    writeFileSync(brief, "Confirm the local smoke request. Do not run external commands.");
    writeFileSync(evidence, "native smoke evidence");
    const requests: string[] = [];
    const release = Promise.withResolvers<void>();
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text();
        requests.push(body);
        if (body.includes(marker)) await release.promise;
        const frame = {
          id: "cataly-harness-local",
          object: "chat.completion.chunk",
          created: 1,
          model: "harness-fixture",
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: "stop" }],
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
            models: [{ id: "harness-fixture", name: "Headless harness fixture" }],
          },
        },
      }),
    );
    writeFileSync(
      config,
      JSON.stringify({
        stateDir,
        defaultModel: "cataly-local/harness-fixture",
        agentCommand: [
          ...omp,
          "--no-extensions",
          "-e",
          resolve(import.meta.dir, "../extension/index.ts"),
          "--cataly-role",
          "lane",
          "--model",
          "{model}",
          "--thinking",
          "off",
          "{prompt}",
        ],
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
      CATALY_TELEMETRY: "0",
      NO_PROXY: "127.0.0.1",
    };
    const rt = new HeadlessRuntime(stateDir, env);
    const store = new Store(home);
    const command = async (...args: string[]) => {
      const result = await run(env, ...args);
      if (result.code !== 0)
        throw new Error(`cataly harness ${args[0]} exited ${result.code}: ${result.err || result.out}`);
      return result.out;
    };
    const observe = async (target: string): Promise<HeadlessObservation> =>
      JSON.parse(await command("observe", target));
    const settledReply = (target: string) =>
      waitFor(async () => {
        const seen = await observe(target);
        return seen.status === "idle" && seen.recent.some((entry) => entry.text === reply) ? seen : undefined;
      });
    const failures: unknown[] = [];
    try {
      expect(await command("up", "--cwd", cwd)).toStartWith("UP runtime=headless");
      const refs = store.roles();
      expect(Object.keys(refs).sort()).toEqual(["duty", "duty-loop", "hourly-loop", "lead"]);
      const [lead, duty] = await Promise.all([observe("lead"), observe("duty")]);
      expect(lead).toMatchObject({ role: "cataly", harnessRole: "lead", cwd });
      expect(duty).toMatchObject({ role: "cataly", harnessRole: "duty", cwd });
      expect(lead.sessionId).toBeTruthy();
      expect(duty.sessionId).toBeTruthy();
      expect(lead.sessionId).not.toBe(duty.sessionId);
      expect(lead.sessionFile).not.toBe(duty.sessionFile);
      expect((await run(env, "up", "--cwd", cwd)).err).toInclude("already registered or held");
      expect(store.roles()).toEqual(refs);

      const status = await command("status");
      expect(status).toInclude("RUNTIME headless (from default)");
      for (const role of ["duty-loop", "hourly-loop"] as const) {
        const ref = refs[role];
        if (!ref) throw new Error(`missing ${role} registration`);
        const seen = await rt.observe(ref);
        expect(seen).toMatchObject({ harnessRole: role, status: "working" });
        expect(seen.sessionId).toBeUndefined();
        expect(status).toInclude(`NATIVE ${role} headless:${ref.id} running pid=${seen.pid} log=`);
        await waitFor(async () => {
          const log = await Bun.file(rt.loopLog(ref)).text();
          return (role === "duty-loop" ? log.includes("DUTY pass events=") : log.includes("LOOP started="))
            ? log
            : undefined;
        });
      }
      expect(store.lastRun()?.skipped).toBeUndefined();
      expect(store.lastRun()).toBeDefined();

      expect(await command("send", "duty", "--text", "DUTY_SMOKE_SYSTEM_SCOPE")).toBe("DELIVERED duty");
      await settledReply("duty");
      expect(
        requests.some((body) => body.includes("DUTY_SMOKE_SYSTEM_SCOPE") && body.includes("You are the DUTY session")),
      ).toBe(true);

      const key = "native-root";
      expect(await command("start", key, "--brief", brief, "--cwd", cwd)).toStartWith(`STARTED ${key} pane=headless:`);
      const lane = await settledReply(key);
      expect(lane).toMatchObject({ role: "lane", cwd, goal: { status: "active" } });
      expect(requests.some((body) => body.includes(`Your lane key is ${key}`))).toBe(true);
      await command("ready", key, "--text", "smoke passed", "--evidence", evidence);
      await command("done", key);
      expect((await rt.observe(lane.ref)).status).toBe("gone");
      await settledReply("lead");
      expect(
        requests.some(
          (body) => body.includes("You are the LEAD session") && !body.includes("You are the DUTY session"),
        ),
      ).toBe(true);

      await command("send", "lead", "--text", marker);
      await waitFor(async () => (requests.some((body) => body.includes(marker)) ? true : undefined));
      const held = await run(env, "stop");
      expect(held.code).toBe(2);
      expect(held.err).toInclude("lead: native role is busy or awaiting an answer");
      expect(store.roles()).toEqual(refs);
      const queuedText = "CATALY_HARNESS_PENDING_INBOX_PROBE";
      expect(await command("send", "lead", "--text", queuedText)).toBe("QUEUED lead");
      const pending = await run(env, "stop");
      expect(pending.code).toBe(2);
      expect(pending.err).toInclude("lead: pending inbox entries");
      expect(store.roles()).toEqual(refs);
      expect((await rt.observe(refs["duty-loop"]!)).status).toBe("working");
      release.resolve();
      await settledReply("lead");
      const queued = await command("inbox", "list", "lead");
      if (!queued.startsWith("EMPTY"))
        expect(await command("send", "lead", "--text", "flush alongside the queued message")).toBe("DELIVERED lead");
      await waitFor(async () => (requests.some((body) => body.includes(queuedText)) ? true : undefined));
      await settledReply("lead");
      expect(await command("inbox", "list", "lead")).toStartWith("EMPTY");
      expect(await command("stop")).toBe("STOPPED native harness");
      expect(store.roles()).toEqual({});
      expect(existsSync(join(home, "harness-native.json"))).toBe(false);
      expect((await rt.observe(lead.ref)).status).toBe("gone");
      expect((await rt.observe(duty.ref)).status).toBe("gone");
    } catch (error) {
      failures.push(error);
    }
    try {
      release.resolve();
      const lane = store.lane("native-root");
      const { lead, duty } = store.roles();
      const agents = [lead, duty, lane?.sessionRef].filter((ref) => ref !== undefined);
      await waitFor(async () => {
        const seen = await Promise.all(agents.map((ref) => rt.observe(ref)));
        return seen.every(({ status }) => status === "idle" || status === "gone") ? true : undefined;
      });
      if (lane && lane.status !== "done") await rt.close(lane.sessionRef);
      await command("stop");
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      failures.push(new Error(`native smoke cleanup unconfirmed; retained ${home}`, { cause: error }));
    } finally {
      provider.stop(true);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "native smoke and graceful cleanup both failed");
  },
  130_000,
);

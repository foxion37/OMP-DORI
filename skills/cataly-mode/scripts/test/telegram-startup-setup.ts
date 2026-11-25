import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-inbound-state.ts";
import { withState } from "./fakes.ts";

export const telegramStartupToken = "test-startup-token-not-for-network";
type Request = { method: string; params: Record<string, unknown> };

export const startup = async (
  scenario: Record<string, unknown> = {},
  args: readonly string[] = ["inbound", "telegram"],
  environment: Record<string, string | undefined> = {},
) => {
  const state = withState();
  const stateDir = state.dir;
  const journal = join(stateDir, "requests.jsonl");
  const store = fileTgInboundStore(stateDir, 222);
  const config = join(state.dir, "config.json");
  store.save({ offset: 17, observedAt: Date.now(), seen: [] });
  writeFileSync(join(state.dir, "telegram-lag.jsonl"), '{"lagMs":12}\n');
  const recall = scenario["recall"] === true;
  writeFileSync(config, JSON.stringify({ stateDir, defaultCwd: stateDir, recall: { enabled: recall } }));
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "record-telegram-startup.ts"),
      join(import.meta.dir, "../src/cli.ts"),
      ...args,
    ],
    {
      cwd: state.dir,
      env: {
        HOME: state.dir,
        PATH: "/usr/bin:/bin",
        CATALY_CONFIG: config,
        CATALY_STATE_DIR: stateDir,
        CATALY_TELEGRAM_TOKEN: telegramStartupToken,
        CATALY_TELEGRAM_OWNER_ID: "7",
        CATALY_TEST_TELEGRAM_REQUESTS: journal,
        CATALY_TEST_TELEGRAM_STARTUP: JSON.stringify({
          identity: { id: 222, is_bot: true },
          webhook: { url: "" },
          ...scenario,
        }),
        ...environment,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    },
  );
  try {
    const error = new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let out = "";
    let held = "";
    if (scenario["hold"] === undefined) child.stdin.end();
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk, { stream: true });
      if (!held && scenario["hold"] !== undefined && out.includes(`STARTUP_WAIT ${scenario["hold"]}\n`)) {
        held = out;
        if (scenario["release"] === true) {
          child.stdin.write("continue\n");
          child.stdin.end();
        } else child.kill("SIGTERM");
      }
    }
    out += decoder.decode();
    const [code, err] = await Promise.all([child.exited, error]);
    const requests: Request[] = existsSync(journal)
      ? readFileSync(journal, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Request)
      : [];
    return {
      code,
      out,
      err,
      held,
      requests,
      methods: requests.map((r) => r.method),
      offset: String(store.load()?.offset),
      recallStored: existsSync(join(state.dir, "recall-scoped-v1.sqlite")),
    };
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    state.done();
  }
};

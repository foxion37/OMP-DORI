import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recallCommand } from "../src/cli-recall.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { conversationRecall, createRecallScope } from "../src/messenger/recall-ledger.ts";
import { withState } from "./fakes.ts";

const enabled = { enabled: true };
const disabled = { enabled: false };
const identity = ["--scope", "telegram:99:10"];
const space = "--space=-1001";
const scopedStore = "recall-scoped-v1.sqlite";

const outputOf = async (input: Parameters<typeof recallCommand>[0]) => {
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  try {
    await recallCommand(input);
    return stdout.mock.calls.map(([line]) => String(line));
  } finally {
    stdout.mockRestore();
  }
};

test.skipIf(process.getuid === undefined)("manual search uses only the explicit identity and chat", async () => {
  const state = withState();
  try {
    const config = { stateDir: state.dir, recall: enabled };
    const recall = conversationRecall({ ...config, scope: createRecallScope("telegram", "99", "10") }, () => {});
    expect(recall).toBeDefined();
    recall?.lead({
      channel: "-1001",
      thread: "-1001/42",
      ref: "1",
      text: "rollout purge rehearsal is friday",
    });
    const [row] = await outputOf({ config, rest: [...identity, space, "--limit", "1", "rollout"] });
    if (row === undefined) throw new Error("expected one result for the seeded conversation");
    const prefix = "RECALL telegram -1001 ";
    expect(row).toStartWith(prefix);
    expect(JSON.parse(String(row).slice(prefix.length))).toMatchObject({
      role: "lead",
      thread: "-1001/42",
      text: "rollout purge rehearsal is friday",
    });
    expect(await outputOf({ config, rest: [...identity, "--space", "555", "rollout"] })).toEqual(["RECALL_NONE"]);
    expect(await outputOf({ config, rest: ["--scope", "telegram:98:10", space, "rollout"] })).toEqual(["RECALL_NONE"]);
    for (const query of [["purge"], ["--", "--purge"]]) {
      expect(await outputOf({ config, rest: [...identity, space, ...query] })).toEqual([row]);
    }
    expect(await outputOf({ config: { ...config, recall: disabled }, rest: ["--purge", ...identity] })).toEqual([
      "RECALL_PURGED 1",
    ]);
    expect(await outputOf({ config, rest: [...identity, space, "rollout"] })).toEqual(["RECALL_NONE"]);
  } finally {
    state.done();
  }
});

test("invalid manual arguments fail before accessing recall state; recall defaults off", async () => {
  const state = withState();
  try {
    const stateDir = join(state.dir, "missing");
    const config = { stateDir, recall: enabled };
    for (const rest of [
      [],
      ["--purge"],
      [space, "query"],
      [...identity, "query"],
      [...identity, space, "  "],
      [...identity, space, "query", "--unknown"],
      [...identity, space, "query", "--limit", "1e2"],
      [...identity, space, "query", "--limit", "1", "--limit", "2"],
      [...identity, ...identity, space, "query"],
      [...identity, "--purge", "--purge"],
      ["--scope", "slack:99:10", "--purge"],
      ["--scope", "telegram:-99:10", "--purge"],
      ["--scope", "telegram:99:-10", "--purge"],
      ["--scope", "telegram:99:99", "--purge"],
      ["--scope", "telegram:99:9007199254740992", "--purge"],
      ["--scope", "telegram:99:synthetic-token", "--purge"],
      ["--scope", "discord:18446744073709551616:10", "--purge"],
      ["--scope", "discord:099:10", "--purge"],
      ["--scope", "discord:99:10:extra", "--purge"],
      ["--scope", "discord:99:10\n", "--purge"],
      [...identity, "--space=-1001/42", "query"],
      [...identity, "--space", "0", "query"],
      [...identity, "--purge=true"],
      [...identity, "--purge", space],
      [...identity, "--purge", "--limit", "1"],
      [...identity, "--purge", "query"],
    ]) {
      // A bad path makes any premature filesystem call fail with something other than an argument error.
      await expect(recallCommand({ config: { ...config, stateDir: `${stateDir}\0` }, rest })).rejects.toBeInstanceOf(
        MessengerError,
      );
      await expect(recallCommand({ config, rest })).rejects.toBeInstanceOf(MessengerError);
      expect(existsSync(stateDir)).toBe(false);
    }
    await expect(recallCommand({ config: { stateDir }, rest: [...identity, space, "query"] })).rejects.toThrow(
      "recall is off",
    );
    expect(await outputOf({ config: { stateDir }, rest: [...identity, "--purge"] })).toEqual(["RECALL_PURGED 0"]);
    expect(existsSync(stateDir)).toBe(false);
  } finally {
    state.done();
  }
});

test.skipIf(process.platform !== "win32")("Windows recall does not create, open, or purge a local ledger", async () => {
  const state = withState();
  const path = join(state.dir, scopedStore);
  const config = { stateDir: state.dir, recall: enabled };
  const warnings: string[] = [];
  try {
    const scope = createRecallScope("telegram", "99", "10");
    const recall = conversationRecall({ ...config, scope }, (warning) => warnings.push(warning));
    expect(recall?.owner({ channel: "-1001", thread: "-1001", ref: "1", text: "earlier note" })).toBeUndefined();
    expect(warnings).toEqual(["recall: recall ledger requires POSIX file ownership and permissions"]);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, "fixture ledger kept byte-for-byte");
    for (const rest of [
      [...identity, space, "note"],
      [...identity, "--purge"],
    ])
      await expect(recallCommand({ config, rest })).rejects.toThrow("requires POSIX file ownership and permissions");
    expect(readFileSync(path, "utf8")).toBe("fixture ledger kept byte-for-byte");
  } finally {
    state.done();
  }
});

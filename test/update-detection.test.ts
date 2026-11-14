import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { runUpdate } from "../src/update/cli.ts";
import { UpdateInterrupted } from "../src/update/config.ts";
import { DoriUpdater } from "../src/update/controller.ts";
import { loadUpdateConfig } from "../src/update/load.ts";
import { detectHead } from "../src/update/prepare.ts";
import type { UpdateState } from "../src/update/types.ts";
import { detectionReceipt, detectorFixture, waitFor } from "./update-detection-setup.ts";
import { fixture } from "./update-setup.ts";

describe("bounded configured ref detection", () => {
  test("a completed unavailable ref check is retryable and the next check recovers without candidate work", async () => {
    const f = fixture();
    const config = join(f.directory, "config.json");
    f.write(f.directory, "config.json", JSON.stringify(f.config));
    const updater = new DoriUpdater(loadUpdateConfig(config), () => {});
    renameSync(join(f.remote, ".git"), join(f.remote, ".git.offline"));
    try {
      expect(await runUpdate(["check", "--config", config])).toBe(4);
      expect(detectionReceipt(f.config.root).exitCode).not.toBe(0);
      expect(updater.status().state.jobs).toEqual({});
      expect(updater.status().state.active).toBeUndefined();
      expect(updater.status().state.observed).toBeUndefined();
    } finally {
      renameSync(join(f.remote, ".git.offline"), join(f.remote, ".git"));
    }
    expect(await runUpdate(["check", "--config", config])).toBe(0);
    expect(detectionReceipt(f.config.root).exitCode).toBe(0);
    expect(updater.status().state.observed).toBe(f.config.baseUpstream);
    expect(updater.status().state.jobs).toEqual({});
  });

  test("resolves the configured head and retains separate private invocation receipts", async () => {
    const f = fixture();
    expect(await detectHead(f.updater.context)).toBe(f.config.baseUpstream);
    const first = detectionReceipt(f.config.root);
    const stdout = readFileSync(first.stdout, "utf8");
    expect(await detectHead(f.updater.context)).toBe(f.config.baseUpstream);
    const second = detectionReceipt(f.config.root);
    expect(second.stdout).not.toBe(first.stdout);
    expect(second.stderr).not.toBe(first.stderr);
    expect(second.receiptPath).not.toBe(first.receiptPath);
    expect(readFileSync(first.stdout, "utf8")).toBe(stdout);
    for (const { receiptPath, ...receipt } of [first, second]) {
      expect(receipt.pid).toBeGreaterThan(0);
      expect(receipt.exitCode).toBe(0);
      expect(receipt.error).toBeUndefined();
      expect(receipt.finishedAt).toBeDefined();
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt);
      for (const path of [receiptPath, receipt.stdout, receipt.stderr]) {
        expect(statSync(path).mode & 0o077).toBe(0);
      }
    }
  });

  test("an already-aborted stage launches no detector and records no source attempt", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const updater = new DoriUpdater(f.config, () => {}, controller.signal);
    const error = await updater.once("stage").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(UpdateInterrupted);
    expect(updater.status().state.jobs).toEqual({});
    expect(updater.status().state.observed).toBeUndefined();
    expect(existsSync(join(f.config.root, "detector"))).toBe(false);
    expect(existsSync(join(f.config.root, "jobs"))).toBe(false);
  });

  test.each(["exit", "abort", "escape"] as const)(
    "%s preserves interruption unless the owned group and output are proven stopped",
    async (mode) => {
      const f = detectorFixture(mode);
      let paths: string[] = [];
      let before: string[] = [];
      try {
        await waitFor(() => existsSync(f.result));
        expect(await f.proc.exited).toBe(0);
        expect(await f.stderr).toBe("");
        const result = JSON.parse(readFileSync(f.result, "utf8")) as {
          interrupted: boolean;
          unavailable: boolean;
          state: UpdateState;
        };
        expect(result.interrupted).toBe(mode !== "exit");
        expect(result.unavailable).toBe(mode === "exit");
        expect(result.state.jobs).toEqual({});
        expect(result.state.observed).toBeUndefined();
        expect(result.state.active).toBeUndefined();
        expect(existsSync(join(f.config.root, "jobs"))).toBe(false);
        const receipt = detectionReceipt(f.config.root);
        const direct = JSON.parse(readFileSync(f.ready, "utf8")) as { pid: number; group: number };
        expect(direct.group).toBe(direct.pid);
        expect(receipt.pid).toBe(direct.pid);
        expect(receipt.finishedAt).toBeDefined();
        expect(receipt.detector?.group).toBe(direct.pid);
        expect(receipt.detector?.groupVerified).toBe(true);
        expect(receipt.detector?.outputComplete).toBe(mode !== "escape");
        expect(receipt.detector?.stopped).toBe(mode !== "escape");
        if (mode === "escape") {
          expect(receipt.error).toContain("descendants may still be running");
          const descendant = JSON.parse(readFileSync(f.identity, "utf8")) as { pid: number; group: number };
          expect(descendant.group).toBe(descendant.pid);
          expect(receipt.detector?.escaped).toContain(descendant.pid);
          const effects = statSync(f.effects).size;
          await waitFor(() => statSync(f.effects).size > effects);
        } else {
          expect(receipt.detector?.escaped).toEqual([]);
        }
        if (mode === "exit") expect(receipt.exitCode).toBe(0);
        else expect(receipt.signal).toBe("SIGKILL");
        const { receiptPath, ...local } = receipt;
        expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(local);
        expect(readFileSync(receipt.stdout, "utf8")).toContain(f.config.baseUpstream);
        expect(readFileSync(receipt.stderr, "utf8")).toContain("detector stderr before inherited hold");
        expect(existsSync(f.stopped)).toBe(false);
        paths = [receipt.stdout, receipt.stderr];
        before = paths.map((path) => readFileSync(path, "utf8"));
      } finally {
        await f.cleanup();
      }
      expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
    },
    30_000,
  );
});

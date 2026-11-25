import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headReceipt } from "../head-receipt.ts";

const posix = test.skipIf(typeof process.getuid !== "function");

const roots: string[] = [];
const identity = "99:10:20:101";
const fingerprint = "a".repeat(64);
const receipt = (outcome: "accepted" | "rejected", patch = {}) => ({
  type: outcome === "accepted" ? "custom_message" : "custom",
  customType: outcome === "accepted" ? "cataly-monitor" : "omp-cataly:admission-rejected",
  id: "native-entry-1",
  [outcome === "accepted" ? "details" : "data"]: { ompCatalyAdmission: { identity, fingerprint } },
  ...patch,
});
const transcript = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "cataly-native-receipt-"));
  roots.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

posix.each(["accepted", "rejected"] as const)(
  "a %s receipt requires the exact original native entry",
  async (outcome) => {
    const file = transcript(`${JSON.stringify(receipt(outcome))}\n`);
    expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome, receipt: "native-entry-1" });
    expect(await headReceipt(file, "99:10:20:102", fingerprint)).toBeUndefined();
  },
);

posix.each(["accepted", "rejected"] as const)(
  "the newest exact %s admission receipt wins over an older receipt",
  async (outcome) => {
    const newer = {
      type: outcome === "accepted" ? "custom_message" : "custom",
      customType: outcome === "accepted" ? "cataly-monitor" : "omp-cataly:admission-rejected",
      id: "head-entry",
      [outcome === "accepted" ? "details" : "data"]: { ompCatalyAdmission: { identity, fingerprint } },
    };
    const older = receipt(outcome === "accepted" ? "rejected" : "accepted");
    const file = transcript(`${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`);
    expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome, receipt: "head-entry" });
  },
);

posix("an accepted receipt the previous main recorded as dori-monitor still resolves", async () => {
  // The previous main wrote this kind with its own metadata key; the reader accepts both, and writes neither.
  const previous = {
    type: "custom_message",
    customType: "dori-monitor",
    id: "previous-entry",
    details: { ompDoriAdmission: { identity, fingerprint } },
  };
  const file = transcript(`${JSON.stringify(previous)}\n`);
  expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome: "accepted", receipt: "previous-entry" });
  expect(await headReceipt(file, "99:10:20:102", fingerprint)).toBeUndefined();
  // Its metadata key is not read for the current message kind, which the previous main never wrote.
  const mixed = transcript(`${JSON.stringify({ ...previous, customType: "cataly-monitor" })}\n`);
  expect(await headReceipt(mixed, identity, fingerprint)).toBeUndefined();
});

posix("stdout-shaped text and an unterminated native tail are not admission receipts", async () => {
  const body = JSON.stringify(receipt("accepted"));
  const file = transcript(`${JSON.stringify({ type: "message", content: body })}\n${body}`);
  expect(await headReceipt(file, identity, fingerprint)).toBeUndefined();
});

posix.each([{ details: { ompCatalyAdmission: { identity, fingerprint: "b".repeat(64) } } }, { id: "" }, { id: null }])(
  "conflicting identity metadata never authorizes acknowledgement %#",
  async (patch) => {
    const file = transcript(`${JSON.stringify(receipt("accepted", patch))}\n`);
    await expect(headReceipt(file, identity, fingerprint)).rejects.toThrow("identity conflict");
  },
);

posix("large unrelated native entries cannot hide or inflate the bounded receipt read", async () => {
  const file = transcript(
    JSON.stringify({ type: "message", content: "x".repeat(2 * 1024 * 1024) }) +
      "\n" +
      JSON.stringify(receipt("accepted")) +
      "\n",
  );
  expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome: "accepted", receipt: "native-entry-1" });
});

posix(
  "reverse proof reads preserve UTF-8 and framing across blocks, oversized entries and a partial tail",
  async () => {
    const body = JSON.stringify(receipt("accepted", { content: "\ud55c\uae00".repeat(30000) }));
    const unrelated = JSON.stringify({ type: "message", content: "x".repeat(2 * 1024 * 1024) });
    const file = transcript(`${unrelated}\n${body}\n${unrelated}\n${JSON.stringify(receipt("rejected"))}`);
    expect(await headReceipt(file, identity, fingerprint)).toEqual({ outcome: "accepted", receipt: "native-entry-1" });
  },
);

test.skipIf(
  typeof process.getuid !== "function" ||
    !process.env["CATALY_DISCORD_NATIVE_BIN"] ||
    process.env["CATALY_DISCORD_NATIVE_BIN"] === "off",
)("an oversized Rust receipt fails only its own routing request", async () => {
  const oversized = transcript(`${JSON.stringify(receipt("accepted", { id: "x".repeat(128 * 1024) }))}\n`);
  const next = transcript(`${JSON.stringify(receipt("rejected"))}\n`);
  await expect(headReceipt(oversized, identity, fingerprint)).rejects.toThrow("response exceeded the frame limit");
  expect(await headReceipt(next, identity, fingerprint)).toEqual({ outcome: "rejected", receipt: "native-entry-1" });
});

posix("symlinks and multiply-linked files cannot substitute a native receipt target", async () => {
  const file = transcript(`${JSON.stringify(receipt("accepted"))}\n`);
  const alias = `${file}.alias`;
  symlinkSync(file, alias);
  await expect(headReceipt(alias, identity, fingerprint)).rejects.toThrow();
  linkSync(file, `${file}.hardlink`);
  await expect(headReceipt(file, identity, fingerprint)).rejects.toThrow("owned regular native transcript");
});

test.skipIf(typeof process.getuid === "function")("native receipt is denied without ownership evidence", async () => {
  const file = transcript(`${JSON.stringify(receipt("accepted"))}\n`);
  await expect(headReceipt(file, identity, fingerprint)).rejects.toThrow("owned regular native transcript");
});

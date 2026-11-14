import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateCommand } from "../src/update/types.ts";

export type RecordingReporter = {
  readonly command: UpdateCommand;
  readonly started: string;
  readonly release: () => void;
  readonly attempts: () => Array<Record<string, unknown>>;
  readonly delivered: () => Array<Record<string, unknown>>;
};

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("notification fixture did not reach its delivery boundary");
    await Bun.sleep(5);
  }
}

/** The reporter delivers to a synchronized local mailbox, with a separate externally released delivery gate. */
export function recordingReporter(
  directory: string,
  mode: "accepted" | "failed" | "ambiguous" = "accepted",
): RecordingReporter {
  const script = join(directory, "notice-reporter.ts");
  const started = join(directory, "notice-started");
  const gate = join(directory, "notice-release");
  const attempts = join(directory, "notice-attempts.jsonl");
  const mailbox = join(directory, "notice-mailbox.jsonl");
  writeFileSync(
    script,
    `import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
const text = process.argv[2];
const notice = JSON.parse(text);
if (notice.outcome.startsWith("before-")) {
  appendFileSync(${JSON.stringify(attempts)}, text + "\\n");
  writeFileSync(${JSON.stringify(started)}, "started");
  if (${JSON.stringify(mode)} === "failed") process.exit(23);
  if (${JSON.stringify(mode)} === "ambiguous") await Bun.sleep(60_000);
  while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
}
const fd = openSync(${JSON.stringify(mailbox)}, "a", 0o600);
try { writeFileSync(fd, text + "\\n"); fsyncSync(fd); } finally { closeSync(fd); }
`,
  );
  const command: UpdateCommand = {
    name: "notice-delivery",
    argv: [process.execPath, script, "{text}"],
    timeoutMs: mode === "ambiguous" ? 1_000 : 10_000,
  };
  const rows = (path: string): Array<Record<string, unknown>> => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
  };
  return {
    command,
    started,
    release: () => writeFileSync(gate, "deliver"),
    attempts: () => rows(attempts),
    delivered: () => rows(mailbox),
  };
}

// Readers whose code does not differ between hosts: the memory ratio every non-macOS host uses, the POSIX ps start
// time, and the directory flush Darwin and Linux share. Implementations re-export the ones their OS can use.
import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { freemem, totalmem } from "node:os";

/** os.freemem() as a whole percent of os.totalmem(); the fallback macOS uses when sysctl cannot answer. */
export const memoryFreePct = (): number => Math.round((freemem() / totalmem()) * 100);

/**
 * `ps -o lstart=` for one pid in the reader's own zone, as src/update/state.ts writes it, or "" when ps exits
 * non-zero or prints nothing, which Date.parse cannot read and callers already treat as "not a live owner".
 */
export const liveOwnerStart = (pid: number): string => {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
    timeout: 1_000,
  });
  return ps.status === 0 ? (ps.stdout?.trim() ?? "") : "";
};

/** Flush a directory's own entries after a rename or link: a filesystem without a directory handle cannot. */
export const syncDirectory = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

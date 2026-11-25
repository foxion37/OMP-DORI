import { mkdirSync } from "node:fs";

import type { Lane } from "../src/registry.ts";
import { type FakeSession, nativeLane, type World } from "./fakes.ts";

/**
 * A live native lane `sid(n)` that a native close can settle. Close confirms the session's cwd on disk, so `cwd` is
 * created, and proves the lane's process exited, so the world's process table is init plus one `omp` process per live
 * native session: closing the session removes its process.
 */
export const closableLane = (
  w: World,
  n: number,
  cwd: string,
  patch: Partial<FakeSession> = {},
): Pick<Lane, "sessionRef" | "session" | "sessionFile" | "cwd"> => {
  mkdirSync(cwd, { recursive: true });
  Object.defineProperty(w, "procs", {
    configurable: true,
    enumerable: true,
    get: () => [
      { pid: 1, ppid: 0, cmd: "init" },
      ...Object.values(w.sessions).flatMap((s) => (s.pid === undefined ? [] : [{ pid: s.pid, ppid: 1, cmd: "omp" }])),
    ],
  });
  return { ...nativeLane(w, n, { cwd, ...patch }), cwd };
};

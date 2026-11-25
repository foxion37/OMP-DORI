import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNativeHost } from "../../test/fixtures/omp-native-host/host.ts";
import { type FakePi, load, until, useConfig } from "./fake-pi.ts";

const run = (pi: FakePi, params: Record<string, unknown>) =>
  pi.tools.get("monitor")!.execute("call", params, undefined, undefined, pi.ctx());

// Windows locks the open journal directory; this fault injection requires POSIX rename semantics.
test.skipIf(process.platform === "win32")(
  "an actual native append failure cannot authorize a daemon retry",
  async () => {
    await assertNativeHost();
    // Bind the public entry point of the installed pinned host, not an optional extension peer.
    const { SessionManager } = await import(join(process.env["CATALY_TEST_OMP_ROOT"]!, "src/index.ts"));
    const stateDir = useConfig();
    const root = dirname(stateDir);
    const journal = join(root, "journal");
    const saved = join(root, "saved-journal");
    const marker = join(root, "runs");
    const release = join(root, "release");
    const manager = SessionManager.create(root, journal);
    await manager.ensureOnDisk();
    const failures: Error[] = [];
    const unsubscribe = manager.onPersistenceError((error: Error) => failures.push(error));
    const pi = await load({
      session: { id: manager.getSessionId(), file: manager.getSessionFile(), entries: [] },
      flags: { "cataly-role": "cataly" },
    });
    const context = pi.ctx;
    pi.ctx = () => ({ ...context(), cwd: root, sessionManager: manager });
    pi.api.appendEntry = (kind, data) => {
      manager.appendCustomEntry(kind, data);
    };
    try {
      await pi.emit("session_start");
      await run(pi, {
        op: "start",
        name: "durable",
        mode: "daemon",
        restart: { max: 2, backoffSec: 0.03 },
        filter: ".",
        argv: [
          process.execPath,
          "-e",
          `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'run'); while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10); process.exit(7)`,
        ],
      });
      await until(() => existsSync(marker));
      expect(readFileSync(manager.getSessionFile(), "utf8")).toContain('"op":"start"');
      renameSync(journal, saved);
      writeFileSync(journal, "block the real journal directory, not the desired manifest");
      writeFileSync(release, "go");
      await until(() =>
        pi.messages.some((message) => /exit state was not recorded|restart limit reached/.test(message.content)),
      );
      expect(failures.length).toBeGreaterThan(0);
      expect(readFileSync(marker, "utf8")).toBe("run");
      expect(pi.messages.map((message) => message.content).join("\n")).toContain("exit state was not recorded");
    } finally {
      await pi.emit("session_shutdown");
      if (existsSync(saved)) {
        rmSync(journal);
        renameSync(saved, journal);
      }
      if (failures.length) await expect(manager.close()).rejects.toThrow(/ENOTDIR|Not a directory/);
      else await manager.close();
      unsubscribe();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

import { writeFileSync } from "node:fs";
import type { Exec } from "../src/runtime/exec.ts";

export type ChildCapture = {
  readonly serverPid: number;
  readonly childPid: number;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** A separate server owns the child environment; only explicit terminal creation values cross IPC. */
export function terminalServer(base: Exec, env: Record<string, string>) {
  const pending: ((capture: ChildCapture) => void)[] = [];
  const captures: ChildCapture[] = [];
  const sessions = new Map<string, { cwd: string; env: Record<string, string> }>();
  const server = Bun.spawn(
    [
      process.execPath,
      "-e",
      `process.on("message", request => {
        if (request === "close") { process.disconnect(); return; }
        const child = Bun.spawnSync(request.argv, {
          cwd: request.cwd, env: { ...process.env, ...request.env },
        });
        process.send({ serverPid: process.pid, childPid: child.pid, code: child.exitCode,
          stdout: child.stdout.toString(), stderr: child.stderr.toString() });
      });`,
    ],
    {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ipc(message) {
        pending.shift()!(message as ChildCapture);
      },
    },
  );
  const command = (argv: readonly string[], cwd: string, overrides: Record<string, string> = {}) => {
    const { promise, resolve } = Promise.withResolvers<ChildCapture>();
    pending.push(resolve);
    server.send({ argv: [...argv], cwd, env: overrides });
    return promise;
  };
  const exec: Exec = async (cmd, argv, options) => {
    const result = await base(cmd, argv, options);
    const args = argv.filter((_, at) => !(at === 0 && argv[0] === "--json"));
    const herdrCreate = cmd === "herdr" && (args[1] === "create" || args[1] === "split");
    const hcCreate = cmd === "hc" && args[0] === "run";
    if (result.code === 0 && (herdrCreate || hcCreate)) {
      const values = hcCreate
        ? args.slice(args.indexOf("--") + 2, -1)
        : args.filter((_, at) => args[at - 1] === "--env");
      const context = Object.fromEntries(
        values.map((value) => {
          const at = value.indexOf("=");
          return [value.slice(0, at), value.slice(at + 1)];
        }),
      );
      const parsed = JSON.parse(result.stdout);
      const created = parsed.result ?? parsed;
      const id = hcCreate ? created.address : (created.root_pane ?? created.pane).pane_id;
      sessions.set(id, {
        cwd: args[args.indexOf("--cwd") + 1]!,
        env: {
          ...context,
          ...(hcCreate
            ? { HC_TERMINAL_ID: id }
            : {
                HERDR_PANE_ID: id,
                HERDR_WORKSPACE_ID: (created.root_pane ?? created.pane).workspace_id,
              }),
        },
      });
    }
    const id =
      cmd === "herdr" && args[0] === "pane" && args[1] === "run"
        ? args[2]
        : cmd === "hc" && args[0] === "send" && args[2] === "--"
          ? args[1]
          : undefined;
    if (id && sessions.has(id)) {
      const session = sessions.get(id)!;
      captures.push(await command(["/bin/sh", "-c", args.at(-1)!], session.cwd, session.env));
    }
    return result;
  };
  return {
    exec,
    command,
    captures,
    sessions,
    async close() {
      server.send("close");
      const [code, stderr] = await Promise.all([server.exited, new Response(server.stderr).text()]);
      if (code !== 0) throw new Error(`terminal fixture exited ${code}: ${stderr}`);
    },
  };
}

export function recordingOmp(path: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\0' "$0" "$@"\nprintf '\\nENV\\n'\n/usr/bin/env -0\n`, { mode: 0o755 });
}

export function recorded(capture: ChildCapture) {
  const [argv, environment] = capture.stdout.split("\nENV\n");
  if (environment === undefined) throw new Error(`recording command failed: ${capture.stderr}`);
  return {
    argv: argv!.split("\0").slice(0, -1),
    env: Object.fromEntries(
      environment
        .split("\0")
        .filter(Boolean)
        .map((value) => {
          const at = value.indexOf("=");
          return [value.slice(0, at), value.slice(at + 1)];
        }),
    ),
  };
}

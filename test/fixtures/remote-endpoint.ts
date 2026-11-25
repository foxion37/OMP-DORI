import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { remoteSocketDir, remoteSocketPath } from "../../src/remote/socket-path.ts";

type EndpointOptions = {
  readonly session?: string;
  readonly pane?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly role?: "cataly" | "lane";
};

/** An OMP session's same-host remote endpoint, as the Cataly extension publishes it. */
export async function startTestEndpoint(
  state: string,
  cleanup: Array<() => void | Promise<void>>,
  { session = "native-001", pane, cwd = "/project", pid, role = "lane" }: EndpointOptions = {},
) {
  const dir = remoteSocketDir(state);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const path = remoteSocketPath(state, session);
  const target = {
    session,
    generation: "original",
    role,
    status: "idle",
    cwd,
    ...(pane === undefined ? {} : { pane }),
    ...(pid === undefined ? {} : { pid }),
  } as const;
  let inputs = 0;
  let closeReply: "refused" | "lost" = "refused";
  const server = createServer((connection) => {
    connection.setEncoding("utf8");
    let pending = "";
    connection.on("data", (bytes: string) => {
      pending += bytes;
      if (!pending.includes("\n")) return;
      const request = JSON.parse(pending) as { op: string; generation?: string; text?: string };
      if (request.op === "info")
        connection.end(`${JSON.stringify({ ok: true, data: target })}\n`);
      else if (request.generation !== target.generation) connection.end('{"ok":false,"error":"wrong generation"}\n');
      else if (request.op === "read")
        connection.end('{"ok":true,"data":{"messages":[{"role":"assistant","text":"status"}]}}\n');
      else if (request.op === "events")
        connection.end('{"ok":true,"data":{"cursor":1,"events":[{"cursor":1,"type":"completion"}],"gap":false}}\n');
      else if (request.op === "send") {
        inputs++;
        connection.end(`${JSON.stringify({ ok: true, data: { status: "admitted", text: request.text } })}\n`);
      } else if (request.op === "close") {
        if (closeReply === "lost") connection.end();
        else connection.end('{"ok":false,"error":"close held by approval"}\n');
      } else connection.end('{"ok":false,"error":"unsupported"}\n');
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, listening.resolve);
  await listening.promise;
  cleanup.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  chmodSync(path, 0o600);
  return { target, inputs: () => inputs, loseCloseReply: () => (closeReply = "lost") };
}

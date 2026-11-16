import { type DeploymentCli, herdrDeploymentCli } from "../src/update/deployment-cli.ts";
import type { DeploymentConfig } from "../src/update/deployment-types.ts";

export function foregroundCli(
  config: DeploymentConfig,
  observe: () => { front: unknown; status: string },
  run?: (line: string) => void,
): DeploymentCli {
  return herdrDeploymentCli(async (cmd, args) => {
    if (cmd === "herdr") {
      const { front, status } = observe();
      if (args[3] === "run" && run) {
        run(args[5]!);
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      }
      const result =
        args[3] === "get"
          ? { pane: { agent: "omp", agent_status: status } }
          : args[3] === "process-info"
            ? { process_info: front }
            : undefined;
      if (!result) throw new Error("unexpected mutating herdr operation");
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    }
    if (cmd !== "ps") throw new Error("unexpected native command");
    const proc = Bun.spawn([cmd, ...args], {
      env: { PATH: "/usr/bin:/bin", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }, config.herdrSession!);
}

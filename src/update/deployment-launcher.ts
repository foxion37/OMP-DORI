import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDeploymentConfig } from "./deployment-config.ts";
import { restartDeployment } from "./deployment-restart.ts";

if (import.meta.main) {
  try {
    const [path, ...args] = process.argv.slice(2);
    if (!path) throw new Error("managed restart requires its concrete deployment config file");
    const configPath = resolve(path);
    const config = parseDeploymentConfig(JSON.parse(readFileSync(configPath, "utf8")), dirname(configPath));
    if (args.length !== 0 && !(args.length === 2 && args[0] === "--model" && args[1] === config.model))
      throw new Error("managed restart model must equal the configured pinned model");
    const record = await restartDeployment(config);
    process.stdout.write(
      `${JSON.stringify({ status: record.status, sessionId: config.sessionId, pid: record.runtime?.pid })}\n`,
    );
    if (record.status !== "healthy") process.exitCode = 2;
  } catch {
    process.stderr.write("managed restart held; inspect owned deployment transaction receipts\n");
    process.exitCode = 2;
  }
}

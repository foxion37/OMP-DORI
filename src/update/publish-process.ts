import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { object, UpdateError, UpdateInterrupted } from "./config.ts";
import type { PublishConfig } from "./publish-types.ts";

const SAFE_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "credential.helper=",
];

/** No inherited tokens/config or raw stdout/stderr logs. Auth is used only by controller-owned remote commands. */
export class PublicationProcess {
  readonly repository: string;
  private readonly home: string;

  constructor(
    readonly config: PublishConfig,
    readonly directory: string,
    private readonly signal?: AbortSignal,
  ) {
    this.repository = join(directory, "repository.git");
    this.home = join(directory, "home");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
  }

  private environment(auth: boolean): Record<string, string> {
    return {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: auth ? (this.config.github?.credentialHome ?? this.home) : this.home,
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_ATTR_NOSYSTEM: "1",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      ...(auth && this.config.github
        ? { GH_CONFIG_DIR: join(this.config.github.credentialHome, ".config", "gh") }
        : {}),
    };
  }

  async command(
    argv: readonly string[],
    input?: string | Uint8Array,
    auth = false,
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    if (this.signal?.aborted) throw new UpdateInterrupted("publication interrupted before command");
    const proc = Bun.spawn([...argv], {
      cwd: this.directory,
      env: { ...this.environment(auth), ...extraEnv },
      stdin: input === undefined ? "ignore" : typeof input === "string" ? Buffer.from(input) : input,
      stdout: "pipe",
      stderr: "ignore",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    const reader = proc.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stop = (): void => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      void reader.cancel().catch(() => {});
    };
    const { promise: expired, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      stop();
      reject(new UpdateInterrupted("publication command or output deadline expired; readback required"));
    }, 65_000);
    const abort = (): void => {
      stop();
      reject(new UpdateInterrupted("publication interrupted; readback required"));
    };
    this.signal?.addEventListener("abort", abort, { once: true });
    const output = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return Buffer.concat(chunks).toString("utf8");
        size += chunk.value.byteLength;
        if (size > 64 * 1024 * 1024) throw new UpdateError("publication output exceeded its admission bound");
        chunks.push(chunk.value);
      }
    })();
    try {
      const [code, text] = await Promise.race([Promise.all([proc.exited, output]), expired]);
      if (code !== 0 || proc.signalCode) throw new UpdateError("publication command failed; remote readback required");
      return text;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
      stop();
      void output.catch(() => {});
    }
  }

  git(argv: readonly string[], input?: string, auth = false, env: Readonly<Record<string, string>> = {}) {
    const gh = this.config.github?.gh;
    const helper =
      auth && gh ? ["-c", `credential.helper=!exec '${gh.replaceAll("'", "'\\''")}' auth git-credential`] : [];
    return this.command(["git", ...SAFE_GIT, ...helper, "--git-dir", this.repository, ...argv], input, auth, env);
  }

  async api(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const github = this.config.github;
    if (!github) throw new UpdateError("GitHub API requires the configured controller capability");
    const output = await this.command(
      [
        github.gh,
        "api",
        "--hostname",
        "github.com",
        "--method",
        method,
        ...(body === undefined ? [] : ["--input", "-"]),
        path,
      ],
      body === undefined ? undefined : JSON.stringify(body),
      true,
    );
    try {
      return JSON.parse(output);
    } catch {
      throw new UpdateError("GitHub returned an invalid publication response");
    }
  }

  async pages(path: string, collection?: "check_runs" | "statuses"): Promise<unknown[]> {
    const pages: unknown[] = [];
    for (let number = 1; ; number++) {
      const page = await this.api(`${path}${path.includes("?") ? "&" : "?"}page=${number}`);
      const entries = collection === undefined ? page : object(page) ? page[collection] : undefined;
      if (!Array.isArray(entries)) throw new UpdateError("GitHub publication pagination is incomplete");
      pages.push(page);
      if (entries.length < 100) return pages;
    }
  }
}

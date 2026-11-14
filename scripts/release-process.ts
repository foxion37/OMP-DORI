export async function command(argv: string[], cwd = process.cwd(), input?: string | Uint8Array): Promise<Buffer> {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_") || key === "TAR_OPTIONS" || key === "GZIP") delete environment[key];
  }
  Object.assign(environment, {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
    TZ: "UTC",
  });
  const child = Bun.spawn(argv, {
    cwd,
    env: environment,
    stdin: input === undefined ? "ignore" : typeof input === "string" ? Buffer.from(input) : input,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${argv[0]} failed (${code}): ${stderr.trim()}`);
  return Buffer.from(stdout);
}

export function git(root: string, args: string[], input?: string): Promise<Buffer> {
  return command(
    [
      "git",
      "--literal-pathspecs",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    root,
    input,
  );
}

/** gh uses only its normal existing capability or the caller's GITHUB_TOKEN/GH_TOKEN environment. */
export async function githubApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const args = [
    "gh",
    "api",
    "--hostname",
    "github.com",
    "--method",
    method,
    path,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (body !== undefined) args.push("--input", "-");
  const result = await command(args, process.cwd(), body === undefined ? undefined : JSON.stringify(body));
  return result.length ? JSON.parse(result.toString("utf8")) : undefined;
}

export async function githubPages(path: string, collection?: string): Promise<unknown[]> {
  const result = await command([
    "gh",
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    path,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ]);
  const pages: unknown = JSON.parse(result.toString("utf8"));
  if (!Array.isArray(pages)) throw new Error("GitHub pagination response is incomplete");
  return pages.flatMap((page: unknown) => {
    const rows =
      collection && typeof page === "object" && page !== null ? (page as Record<string, unknown>)[collection] : page;
    if (!Array.isArray(rows)) throw new Error("GitHub pagination collection is incomplete");
    return rows as unknown[];
  });
}

export function githubAsset(repository: string, id: number): Promise<Buffer> {
  return command([
    "gh",
    "api",
    "--hostname",
    "github.com",
    `repos/${repository}/releases/assets/${id}`,
    "-H",
    "Accept: application/octet-stream",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ]);
}

export async function uploadAsset(repository: string, release: number, name: string, bytes: Uint8Array): Promise<void> {
  await command(
    [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      `https://uploads.github.com/repos/${repository}/releases/${release}/assets?name=${encodeURIComponent(name)}`,
      "-H",
      "Content-Type: application/octet-stream",
      "-H",
      `Content-Length: ${bytes.byteLength}`,
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "--input",
      "-",
    ],
    process.cwd(),
    bytes,
  );
}

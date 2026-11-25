/** Excluded metadata/secrets are never copied; admission separately holds excluded code before it can execute. */
const OMIT: Readonly<Record<string, true>> = {
  ".git": true,
  node_modules: true,
  ".cataly": true,
  ".omp-cataly": true,
  ".omp": true,
  ".omo": true,
  ".cache": true,
  ".DS_Store": true,
  ".env": true,
  "auth.json": true,
  "credentials.json": true,
};
const ROOT_RUNTIME: Readonly<Record<string, true>> = {
  "config.json": true,
  state: true,
  sessions: true,
  auth: true,
  bin: true,
  cache: true,
  tmp: true,
  globalextensions: true,
  ref: true,
  ".qa-home": true,
  evidence: true,
};
const NATIVE_OUTPUT: Readonly<Record<string, true>> = { target: true, ".cataly-native": true };
export const isLocalNativeOutput = (path: string): boolean => NATIVE_OUTPUT[path] === true;
export const excludesSourcePath = (path: string): boolean => {
  const parts = path.split("/");
  return (
    isLocalNativeOutput(path) ||
    ROOT_RUNTIME[parts[0] ?? ""] === true ||
    parts.some(
      (part) =>
        OMIT[part] === true || /^\.env\.(?!example$|sample$)/.test(part) || /\.(?:pem|key|p12|pfx|tmp)$/.test(part),
    )
  );
};

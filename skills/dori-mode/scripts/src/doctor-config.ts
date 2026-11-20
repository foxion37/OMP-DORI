const checks = [
  "runtime",
  "registry",
  "monitors",
  "monitor-filter",
  "monitor-runtime",
  "supervision",
  "repo-identities",
  "worklog",
  "lessons",
] as const;
export type DoctorCheck = (typeof checks)[number];
export type DoctorOptions = { readonly ignore?: readonly DoctorCheck[] };

export const validDoctorOptions = (value: unknown): value is DoctorOptions => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    Object.keys(raw).every((key) => key === "ignore") &&
    (raw["ignore"] === undefined ||
      (Array.isArray(raw["ignore"]) &&
        raw["ignore"].every((key: unknown) => typeof key === "string" && checks.some((check) => check === key))))
  );
};

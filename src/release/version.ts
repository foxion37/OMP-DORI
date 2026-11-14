import { version } from "../../package.json";

export const releaseVersion: string = version;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

import { Refusal } from "./refusal.ts";
import { formatRef, HEADLESS_ADDRESS, type SessionRef } from "./runtime/types.ts";

/** A ref as Cataly stores and prints it (`tern:42`, `headless:<uuid>`); roles.json, inbox and notices use this form. */
export const refText = (ref: SessionRef): string => formatRef(ref);

export const sameSession = (a: SessionRef, b: SessionRef): boolean => a.runtime === b.runtime && a.id === b.id;

/** Characters a short headless id keeps at least, like git's short SHA. */
const SHORT_MIN = 8;

/** The distinct headless ids in `known`. */
const headlessIds = (known: readonly SessionRef[]): string[] => [
  ...new Set(known.filter((r) => r.runtime === "headless").map((r) => r.id)),
];

/**
 * A ref as a person reads it, its runtime named once as its prefix (`tern:42`). A headless id (a UUID)
 * is cut to its shortest prefix of SHORT_MIN characters or more, never ending in "-", that no other headless id in
 * `known` starts with; `resolveShortRef` reads it back to this ref. `known` must hold every ref that resolution reads
 * (`knownRefs`), so a prefix shown is one it resolves.
 */
export function shortRef(ref: SessionRef, known: readonly SessionRef[]): string {
  if (ref.runtime !== "headless" || !HEADLESS_ADDRESS.test(ref.id)) return formatRef(ref);
  const others = headlessIds(known).filter((id) => id !== ref.id);
  for (let n = SHORT_MIN; n < ref.id.length; n++) {
    const prefix = ref.id.slice(0, n);
    if (!prefix.endsWith("-") && !others.some((id) => id.startsWith(prefix))) return `headless:${prefix}`;
  }
  return formatRef(ref);
}

/**
 * `headless:<prefix>` as `shortRef` shows it, read back to the one headless ref in `known` whose id starts with it;
 * undefined when `text` is not a shortened headless ref (a full one parses as it is). A prefix under SHORT_MIN
 * characters, one no known ref has and one more than one has are refused: a guess could reach the wrong session.
 */
export function resolveShortRef(text: string, known: readonly SessionRef[]): SessionRef | undefined {
  const prefix = /^headless:([0-9a-f][0-9a-f-]*)$/.exec(text)?.[1];
  if (prefix === undefined || HEADLESS_ADDRESS.test(prefix)) return undefined;
  if (prefix.length < SHORT_MIN)
    throw new Refusal(`${text} is too short: a shortened headless ref keeps at least ${SHORT_MIN} characters`);
  const matches = headlessIds(known).filter((id) => id.startsWith(prefix));
  const [only, ...more] = matches;
  if (only === undefined)
    throw new Refusal(`no known headless session starts with ${prefix} (see cataly harness status)`);
  if (more.length)
    throw new Refusal(
      `${text} is ambiguous: it matches ${matches.map((id) => `headless:${id}`).join(", ")}; give more characters`,
    );
  return { runtime: "headless", id: only };
}

import { describe, expect, test } from "bun:test";
import { Runtimes, selfSession } from "../src/runtime/registry.ts";
import type { SessionRuntime } from "../src/runtime/types.ts";
import { formatRef, parseRef } from "../src/runtime/types.ts";

const UUID = "00000000-0000-4000-8000-000000000007";

describe("parseRef / formatRef", () => {
  test.each([
    ["tern:42", { runtime: "tern", id: "42" }],
    [`headless:${UUID}`, { runtime: "headless", id: UUID }],
    ["headless:t7", undefined],
    [UUID, undefined],
    ["42", undefined],
    ["w1:p3", undefined],
    ["t7", undefined],
    ["", undefined],
    ["lead", undefined],
    ["tmux:w1:p3", undefined],
    ["tern:t7", undefined],
    ["tern:", undefined],
    ["tern:42 ", undefined],
    ["machine/t7", undefined],
  ] as const)("parseRef(%p)", (text, want) => {
    expect(parseRef(text)).toEqual(want);
  });

  test.each([
    ["tern:42", { runtime: "tern", id: "42" }],
    [`headless:${UUID} (group dropped)`, { runtime: "headless", id: UUID, group: "abcd1234" }],
    ["tern:42 (group and container dropped)", { runtime: "tern", id: "42", group: "7001", container: "8001" }],
  ] as const)("formatRef gives %s and parses back", (want, ref) => {
    expect(formatRef(ref)).toBe(want.split(" ")[0] ?? "");
    expect(parseRef(formatRef(ref))).toEqual({ runtime: ref.runtime, id: ref.id });
  });
});

describe("Runtimes registry", () => {
  const counting = () => {
    const made: string[] = [];
    const runtimes = new Runtimes("headless", (kind) => {
      made.push(kind);
      return { kind } as SessionRuntime;
    });
    return { made, runtimes };
  };

  test("builds nothing until asked, then memoises the headless runtime", () => {
    const { made, runtimes } = counting();
    expect(made).toEqual([]);
    const a = runtimes.default;
    expect(runtimes.default).toBe(a);
    expect(runtimes.for({ runtime: "headless", id: UUID })).toBe(a);
    expect(made).toEqual(["headless"]);
  });

  test("for(ref) never calls the lazy choice; default does", () => {
    let asked = 0;
    const rts = new Runtimes(
      () => {
        asked += 1;
        return "headless";
      },
      (kind) => ({ kind }) as SessionRuntime,
    );
    expect(rts.for({ runtime: "headless", id: UUID }).kind).toBe("headless");
    expect(asked).toBe(0);
    expect(rts.default.kind).toBe("headless");
    expect(asked).toBe(1);
  });

  test.each([
    ["a headless session", { CATALY_HEADLESS_ID: UUID }, { runtime: "headless", id: UUID }],
    ["a malformed id", { CATALY_HEADLESS_ID: "t7" }, undefined],
    ["outside any runtime", {}, undefined],
  ] as const)("selfSession / selfAny: %s", (_, env, want) => {
    const { made, runtimes } = counting();
    expect(selfSession(env)).toEqual(want);
    expect(runtimes.selfAny(env)).toEqual(want);
    expect(made).toEqual([]);
  });
});

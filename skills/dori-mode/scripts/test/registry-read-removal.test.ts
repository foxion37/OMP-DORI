import { expect, spyOn, test } from "bun:test";
import { type Lane, Registry } from "../src/registry.ts";
import { withState } from "./fakes.ts";

test.each(["list", "scan"] as const)("lane %s tolerates registration removal", async (operation) => {
  const state = withState();
  const registry = new Registry(state.dir);
  const lane: Lane = {
    key: "qa-read-removal",
    title: "read removal race",
    thread: "local-only",
    brief: "local-only",
    done: "local-only",
    openedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(await registry.create(lane)).toBe(true);
  const target = registry.path(lane.key);
  const originalPath = registry.path.bind(registry);
  let removing = false;
  let removed: ReturnType<Registry["discard"]> | undefined;
  const remove = () => {
    if (removing) return;
    removing = true;
    removed = registry.discard(lane);
  };
  const paths = spyOn(registry, "path").mockImplementation((key) => {
    const path = originalPath(key);
    if (key === lane.key) remove();
    return path;
  });
  const originalFile = Bun.file.bind(Bun);
  const files = spyOn(Bun, "file").mockImplementation((path, options) => {
    const file =
      typeof path === "number"
        ? originalFile(path, options)
        : typeof path === "string" || path instanceof URL
          ? originalFile(path, options)
          : originalFile(path, options);
    const json = file.json.bind(file);
    file.json = async () => {
      if (String(path) === target) {
        remove();
        await removed;
      }
      return json();
    };
    return file;
  });
  try {
    if (operation === "list") expect(await registry.list()).toEqual([]);
    else expect(await registry.scan()).toEqual({ lanes: [], unreadable: [] });
    expect(removed).toBeDefined();
    await removed;
    expect(await originalFile(target).exists()).toBe(false);
  } finally {
    paths.mockRestore();
    files.mockRestore();
    state.done();
  }
});

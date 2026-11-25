import { expect, test } from "bun:test";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import { RuntimeChoiceError } from "../src/runtime/select.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

test("cataly status with a long home path holding spaces and no runtime: the path stays whole on one line", async () => {
  const d = new World().deps();
  // Spaces inside a path are no place to break it: either half names no directory.
  const root = join(d.store.root, "Application Support", `${"deep home directory ".repeat(6)}end`);
  const unsupported = "Cataly sessions require macOS or Linux (headless OMP needs a Unix socket)";
  const long = {
    ...d,
    store: new Store(root),
    choice: () => {
      throw new RuntimeChoiceError(unsupported);
    },
  };
  const { out } = await captureIo(async () => {
    await status(long);
    return 0;
  });
  expect(Bun.stringWidth(root)).toBeGreaterThan(120);
  // The path line runs past 120 columns as it must; the terminal folds it, a copy of it is whole.
  expect(out.split("\n").slice(0, 3)).toEqual([`RUNTIME unset: ${unsupported}`, "lead=- duty=-", `home=${root}`]);
});

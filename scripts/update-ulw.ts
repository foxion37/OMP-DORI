import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepareUlwUpdate } from "../src/release/source-bundle-update.ts";

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        source: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.out) throw new Error("Usage: bun scripts/update-ulw.ts --out DIRECTORY [--source CHECKOUT]");
    const candidate = await prepareUlwUpdate(
      resolve(values.source ?? import.meta.dir, values.source ? "" : ".."),
      resolve(values.out),
    );
    console.log(JSON.stringify(candidate ? { changed: true, ...candidate } : { changed: false }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

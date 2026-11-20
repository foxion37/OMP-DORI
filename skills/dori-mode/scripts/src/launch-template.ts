import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { configPath } from "./config.ts";

import { TemplateError } from "./launch-errors.ts";

/** Local operator templates only: {{name}} variables and {{>common}} includes; no evaluation. */
export const renderTemplate = (
  name: string,
  values: Readonly<Record<string, string>>,
  configFile = configPath(),
): string => {
  try {
    const root = realpathSync(join(dirname(configFile), "templates"));
    const render = (current: string, stack: readonly string[]): string => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(current)) throw new TemplateError(`invalid template name: ${current}`);
      const path = realpathSync(join(root, `${current}.md`));
      if (stack.includes(path)) throw new TemplateError(`template include cycle: ${current}`);
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new TemplateError(`template escapes its directory: ${current}`);
      return readFileSync(path, "utf8").replace(/\{\{>\s*([^{}]+?)\s*\}\}/g, (_match, included: string) =>
        render(included.trim(), [...stack, path]),
      );
    };
    const source = render(name, []);
    if (source.replace(/\{\{[^{}]*\}\}/g, "").includes("{{")) throw new TemplateError("malformed template expression");
    return source.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
      const key = raw.trim();
      const value = values[key];
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(key) || !Object.hasOwn(values, key) || typeof value !== "string")
        throw new TemplateError(`missing template variable: ${key}`);
      return value;
    });
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    throw new TemplateError(
      `template unavailable: ${name} (${(error as NodeJS.ErrnoException).code ?? "read failure"})`,
    );
  }
};

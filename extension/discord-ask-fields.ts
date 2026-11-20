import {
  allowed,
  ancestor,
  attr,
  clean,
  controls,
  decode,
  has,
  invalid,
  readFormNodes,
  text,
} from "./discord-ask-html.ts";

export type AskValue = string | number | string[];
export type AskData = Record<string, AskValue>;
type Option = { value: string; label: string; checked: boolean; disabled: boolean };
export type Field = {
  name: string;
  type: string;
  label: string;
  placeholder: string;
  required: boolean;
  disabled: boolean;
  value: string;
  multi: boolean;
  options: Option[];
  other?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
};

export async function parseAskFields(html: string) {
  const { root, nodes } = await readFormNodes(html);
  const forms = nodes.filter((node) => node.tag === "form");
  if (forms.length > 1) invalid();
  const scope = forms[0] ?? root;
  const scoped = nodes.filter((node) => node === scope || ancestor(node, "form") === scope || scope === root);
  const hidden: AskData = {},
    fields: Field[] = [],
    names = new Map<string, Field | null>(),
    ids = new Set<string>();
  for (const node of scoped) {
    if (!Object.hasOwn(allowed, node.tag)) invalid();
    for (const [key, value] of node.attrs) node.attrs.set(key, decode(value));
    for (const key of node.attrs.keys())
      if (
        /^on/i.test(key) ||
        ["style", "hidden", "aria-hidden", "contenteditable", "form", "list", "pattern", "readonly", "step"].includes(
          key,
        )
      )
        invalid();
    const id = attr(node, "id");
    if (id) {
      if (ids.has(id)) invalid();
      ids.add(id);
    }
    if (node.tag === "option" && !["select", "optgroup"].includes(node.parent!.tag)) invalid();
    if (node.tag === "optgroup" && node.parent!.tag !== "select") invalid();
    if (node.tag === "option" && node.children.some((child) => typeof child !== "string")) invalid();
    // OMP treats disabled optgroups differently from disabled options.
    if (node.tag === "optgroup" && has(node, "disabled")) invalid();
    if (
      (node.tag === "select" || node.tag === "optgroup") &&
      node.children.some((child) =>
        typeof child === "string"
          ? !!child.trim()
          : !["option", ...(node.tag === "select" ? ["optgroup"] : [])].includes(child.tag),
      )
    )
      invalid();
  }
  const labels = scoped.filter((node) => node.tag === "label");
  for (const label of labels) {
    const count = scoped.filter(
      (node) => Object.hasOwn(controls, node.tag) && ancestor(node, "label") === label,
    ).length;
    if (ancestor(label, "label") || count > 1 || (count && has(label, "for"))) invalid();
  }
  for (const node of scoped.filter((node) => Object.hasOwn(controls, node.tag))) {
    if (ancestor(node, "select") || ancestor(node, "textarea") || ancestor(node, "button")) invalid();
    const name = attr(node, "name") ?? "",
      type = node.tag === "input" ? (attr(node, "type") ?? "text").toLowerCase() : node.tag;
    if (
      !["text", "textarea", "number", "hidden", "radio", "checkbox", "select", "submit", "reset", "button"].includes(
        type,
      )
    )
      invalid();
    if (["submit", "reset", "button"].includes(type)) continue;
    if ((has(node, "multiple") && type !== "select") || (has(node, "checked") && !["radio", "checkbox"].includes(type)))
      invalid();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || /^(?:constructor|prototype)$/i.test(name)) invalid();
    if (type === "hidden") {
      if (names.has(name)) invalid();
      names.set(name, null);
      hidden[name] = attr(node, "value") ?? "";
      continue;
    }
    if (
      /password|passwd|secret|(?:^|[_-])(?:token|api[_-]?key|private[_-]?key|credentials?)(?:$|[_-])/i.test(name) ||
      /password|one-time-code|cc-/i.test(attr(node, "autocomplete") ?? "")
    )
      invalid();
    const linked = labels.filter((label) => attr(label, "for") === attr(node, "id") && has(node, "id"));
    if (linked.length > 1) invalid();
    const ownLabel = ancestor(node, "label") ?? linked[0];
    const label =
      (ownLabel ? clean(decode(text(ownLabel))) : "") || attr(node, "aria-label") || attr(node, "title") || name;
    let disabled = has(node, "disabled");
    for (let parent = node.parent; parent; parent = parent.parent)
      if (parent.tag === "fieldset" && has(parent, "disabled")) disabled = true;
    const field: Field = {
      name,
      type,
      label,
      placeholder: attr(node, "placeholder") ?? "",
      required: has(node, "required"),
      disabled,
      multi: type === "checkbox" || has(node, "multiple"),
      value: type === "textarea" ? decode(text(node, false)).replace(/^\r?\n/, "") : (attr(node, "value") ?? ""),
      options: [],
    };
    for (const [key, property] of [
      ["min", "min"],
      ["max", "max"],
      ["minlength", "minLength"],
      ["maxlength", "maxLength"],
    ] as const) {
      const value = attr(node, key);
      if (value !== undefined) {
        const number = Number(value);
        if (
          !value.trim() ||
          !Number.isFinite(number) ||
          (key.endsWith("length") && (!Number.isInteger(number) || number < 0))
        )
          invalid();
        if ((key === "min" || key === "max") && type !== "number") invalid();
        if (key.endsWith("length") && !["text", "textarea", "number"].includes(type)) invalid();
        field[property] = number;
      }
    }
    if ((field.min ?? -Infinity) > (field.max ?? Infinity) || (field.minLength ?? 0) > (field.maxLength ?? Infinity))
      invalid();
    if (type === "select") {
      const options = scoped.filter((option) => option.tag === "option" && ancestor(option, "select") === node);
      if (!options.length || options.length > 32) invalid();
      field.options = options.map((option) => ({
        value: attr(option, "value") ?? clean(decode(text(option, false))),
        label: [attr(ancestor(option, "optgroup") ?? option, "label"), clean(decode(text(option, false)))]
          .filter(Boolean)
          .join(": "),
        checked: has(option, "selected"),
        disabled: has(option, "disabled"),
      }));
      if (!field.multi && !field.options.some((option) => option.checked)) {
        const first = field.options.find((option) => !option.disabled);
        if (first) first.checked = true;
      }
    } else if (type === "radio" || type === "checkbox") {
      field.options.push({ value: attr(node, "value") ?? "on", label, checked: has(node, "checked"), disabled });
      field.disabled = false;
    }
    const existing = names.get(name);
    if (names.has(name)) {
      if (!existing || existing.type !== type || !["radio", "checkbox"].includes(type)) invalid();
      existing.options.push(...field.options);
      existing.required ||= field.required;
    } else {
      names.set(name, field);
      fields.push(field);
    }
  }
  if (
    !fields.some(
      (field) => !field.disabled && (!field.options.length || field.options.some((option) => !option.disabled)),
    ) ||
    fields.length > 16
  )
    invalid();
  for (const field of fields) {
    if (field.options.length > 32 || new Set(field.options.map((option) => option.value)).size !== field.options.length)
      invalid();
    if (!field.multi && field.options.filter((option) => option.checked).length > 1) invalid();
    if (
      field.options.length > 1 &&
      (field.type === "radio" || field.type === "checkbox") &&
      !field.options.some((option) => /^\s*other\b/i.test(option.label))
    )
      field.other = true;
  }
  return { fields, hidden, context: decode(text(scope)) };
}

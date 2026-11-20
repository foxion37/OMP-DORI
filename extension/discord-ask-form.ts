import { type AskData, type AskValue, type Field, parseAskFields } from "./discord-ask-fields.ts";
import { clean } from "./discord-ask-html.ts";

export type { AskData } from "./discord-ask-fields.ts";
type AskChoice = {
  readonly label: string;
  readonly value: string;
  readonly recommended: boolean;
};
type AskAnswer = { data: AskData } | { error: string };
export interface AskForm {
  readonly summary: string;
  readonly choices?: {
    readonly context: string;
    readonly options: readonly AskChoice[];
  };
  readonly acceptsPlainText?: true;
}
const privateForms = new WeakMap<AskForm, { fields: Field[]; editable: Field[]; hidden: AskData }>();
const FORM_LIMIT = 16_384,
  ANSWER_LIMIT = 2_000;
function displayPlain(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/`/g, "ˋ")
    .replace(/@/g, "@\u200b")
    .replace(/</g, "＜")
    .replace(/>/g, "＞");
}
export function escapeAskMarkdown(value: string): string {
  return value.replace(/[\\*_~|[\]]/g, "\\$&");
}
function display(value: string): string {
  return escapeAskMarkdown(displayPlain(value));
}
const show = (value: AskValue) =>
  `\`${JSON.stringify(value).replace(/[<@`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
    char
      .split("")
      .map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  )}\``;
function defaultValue(field: Field): AskValue | undefined {
  if (!field.options.length)
    return field.type === "number" && field.value.trim() && Number.isFinite(Number(field.value))
      ? Number(field.value)
      : field.value;
  const checked = field.options.filter((option) => option.checked && !option.disabled).map((option) => option.value);
  return field.multi && field.options.length > 1 ? checked : checked[0];
}
/** Conservatively project only forms whose complete prompt fits a Discord message. */
export async function projectAskForm(html: string): Promise<AskForm | undefined> {
  if (typeof html !== "string" || !html.trim() || html.length > FORM_LIMIT) return undefined;
  try {
    const { fields, hidden, context: visibleText } = await parseAskFields(html);
    const context = visibleText.split("\n").map(clean).filter(Boolean).map(display);
    const lines = fields.map((field) => {
      const flags = [field.type, field.required ? "required" : "optional", ...(field.disabled ? ["disabled"] : [])];
      for (const key of ["min", "max", "minLength", "maxLength"] as const)
        if (field[key] !== undefined) flags.push(`${key}=${field[key]}`);
      const choices = field.options
        .filter((option) => !option.disabled)
        .map((option) => `${show(option.value)} (${display(option.label)})`)
        .join(", ");
      const initial = defaultValue(field);
      return (
        `${show(field.name)}: ${display(field.label)} [${flags.join(", ")}${field.multi && field.options.length > 1 ? ", array" : ""}]` +
        (choices ? `; choices: ${choices}` : "") +
        (initial !== undefined ? `; default: ${show(initial)}` : "") +
        (field.other ? "; Other: include one custom text value" : "") +
        (field.placeholder ? `; hint: ${display(field.placeholder)}` : "") +
        (field.type === "checkbox" && field.options.length === 1 && !field.required ? "; [] clears" : "")
      );
    });
    const summary = [
      ...context,
      ...lines,
      "Reply with a JSON field map; omitted fields keep defaults. One editable field also accepts plain text.",
    ].join("\n");
    if (summary.length > 1_500) return undefined;
    const editable = fields.filter(
      (field) => !field.disabled && (!field.options.length || field.options.some((option) => !option.disabled)),
    );
    const field = editable.length === 1 ? editable[0] : undefined;
    const simpleChoice = field && !field.multi && (field.type === "radio" || field.type === "select");
    const acceptsPlainText =
      field && (field.type === "text" || field.type === "textarea" || (simpleChoice && field.other));
    let choices: AskForm["choices"];
    if (simpleChoice) {
      const options = field.options
        .filter((option) => !option.disabled)
        .map((option) =>
          Object.freeze({
            // An unlabeled radio's synthetic label is its machine field name.
            label: option.label === field.name ? "" : displayPlain(clean(option.label)).trim(),
            value: option.value,
            recommended: option.checked,
          }),
        );
      const label = field.type === "select" && field.label !== field.name ? display(clean(field.label)) : "";
      const prompt = [...context.filter(Boolean), ...(label && !context.includes(label) ? [label] : [])].join("\n");
      choices = Object.freeze({ context: prompt, options: Object.freeze(options) });
    }
    const form: AskForm = Object.freeze({
      summary,
      ...(choices ? { choices } : {}),
      ...(acceptsPlainText ? { acceptsPlainText: true as const } : {}),
    });
    privateForms.set(form, { fields, editable, hidden });
    return form;
  } catch {
    return undefined;
  }
}
/** Resolve an original enabled choice without exposing the field name outside the form parser. */
export function parseAskChoice(form: AskForm, value: string): AskAnswer {
  const field = privateForms.get(form)?.editable[0];
  if (!field || !form.choices?.options.some((option) => option.value === value))
    return { error: "Choose only enabled values shown in the form." };
  return parseAskAnswer(form, JSON.stringify({ [field.name]: value }));
}
/** Validate a reply against the exact projected form, retaining private hidden defaults. */
export function parseAskAnswer(form: AskForm, input: string, plain = false): AskAnswer {
  const model = privateForms.get(form);
  if (!model) return { error: "This form is no longer available." };
  if (typeof input !== "string" || input.length > ANSWER_LIMIT) return { error: "Answer is too long." };
  if (input.trim() === "") return { error: "Enter an answer or a JSON field map." };
  const { editable } = model;
  let answer: Record<string, unknown>;
  const field = editable.length === 1 ? editable[0] : undefined;
  if (plain) {
    if (!form.acceptsPlainText || !field) return { error: "Reply directly to the ASK message." };
    answer = { [field.name]: input };
  } else {
    try {
      const value: unknown = JSON.parse(input);
      if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error();
      answer = value as Record<string, unknown>;
    } catch {
      if (/^\s*[[{]/.test(input)) return { error: "Enter a valid JSON field map." };
      if (!field) return { error: "Use a JSON field map for multiple fields." };
      const labels = form.choices?.options.filter((option) => option.label === input.trim());
      const value = field.options.some((option) => option.value === input)
        ? input
        : labels?.length === 1
          ? labels[0]!.value
          : input;
      answer = { [field.name]: field.multi && field.options.length > 1 ? [value] : value };
    }
  }
  for (const key of Object.keys(answer)) {
    if (!editable.some((field) => field.name === key))
      return { error: `Unknown or disabled field: ${display(key.slice(0, 64))}.` };
  }
  const data: AskData = { ...model.hidden };
  for (const field of model.fields) {
    const supplied = Object.hasOwn(answer, field.name);
    let value: unknown = supplied ? answer[field.name] : defaultValue(field);
    const fail = (reason: string) => ({ error: `${display(field.name)}: ${reason}` });
    if (field.options.length) {
      const array = field.multi && field.options.length > 1;
      if (!array && field.type === "checkbox" && Array.isArray(value) && !value.length) value = undefined;
      if (
        array
          ? !Array.isArray(value) || value.some((item) => typeof item !== "string")
          : value !== undefined && typeof value !== "string"
      )
        return fail(array ? "Enter an array of choice values." : "Enter one choice value.");
      const values: string[] = value === undefined ? [] : Array.isArray(value) ? value : [value as string];
      if (new Set(values).size !== values.length) return fail("Choose only enabled values shown in the form.");
      const selected = new Set<string>();
      let other: string | undefined;
      for (const item of values) {
        const option = field.options.find((option) => option.value === item);
        if (option && !option.disabled) selected.add(item);
        else if (!option && field.other && other === undefined) other = item.trim();
        else return fail("Choose only enabled values shown in the form.");
      }
      const ordered = field.options.filter((option) => selected.has(option.value)).map((option) => option.value);
      if (other) ordered.push(other);
      if (field.required && !ordered.length) return fail(array ? "Select at least one." : "Required.");
      value = array ? ordered : ordered[0];
    } else {
      if (typeof value !== "string" && !(field.type === "number" && typeof value === "number"))
        return fail(field.type === "number" ? "Enter a number." : "Enter text.");
      let string = String(value);
      if (!string.trim()) {
        if (field.required) return fail("Required.");
      } else {
        if (field.type === "number") {
          const number = Number(value);
          if (!Number.isFinite(number)) return fail("Enter a number.");
          if (field.min !== undefined && number < field.min) return fail(`Must be at least ${field.min}.`);
          if (field.max !== undefined && number > field.max) return fail(`Must be at most ${field.max}.`);
          value = number;
          string = String(number);
        }
        if (field.minLength !== undefined && string.length < field.minLength)
          return fail(`Needs at least ${field.minLength} characters.`);
        if (field.maxLength !== undefined && string.length > field.maxLength)
          return fail(`At most ${field.maxLength} characters.`);
      }
    }
    if (value !== undefined) data[field.name] = value as AskValue;
  }
  return { data };
}

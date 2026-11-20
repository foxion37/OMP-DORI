import { type AskData, type AskForm, escapeAskMarkdown, parseAskChoice } from "./discord-ask-form.ts";

type DiscordAskButton = {
  readonly type: 2;
  readonly style: 1 | 2;
  readonly label: string;
  readonly custom_id: string;
};
type DiscordAskRow = { readonly type: 1; readonly components: readonly DiscordAskButton[] };
export type DiscordAskCard = {
  readonly content: string;
  readonly instruction: string;
  readonly rows: readonly DiscordAskRow[];
  readonly answers: Map<string, AskData>;
};

const HANGUL = /\p{Script=Hangul}/u;
const ROW_SIZE = 5;
const MAX_ROWS = 5;

/** Build legacy-compatible message components. Only content and rows belong on the wire. */
export function buildDiscordAskCard(form: AskForm, prefix: string): DiscordAskCard | undefined {
  const choices = form.choices;
  if (!choices || !prefix || choices.options.length === 0 || choices.options.length > ROW_SIZE * MAX_ROWS)
    return undefined;

  const { context, options } = choices;
  // A missing visible label has no meaningful button text without exposing the raw schema.
  if (options.some((option) => !option.label)) return undefined;
  const korean = HANGUL.test(context) || options.some((option) => HANGUL.test(option.label));
  const recommendation = korean ? " (추천)" : " (Recommended)";
  const content = ["**Cataly ASK**"];
  if (context) content.push(context);
  const rows: DiscordAskRow[] = [];
  const answers = new Map<string, AskData>();
  let row: DiscordAskButton[] | undefined;
  for (const [index, choice] of options.entries()) {
    const number = index + 1;
    const customId = `${prefix}:${number}`;
    if (customId.length > 100) return undefined;
    const answer = parseAskChoice(form, choice.value);
    if ("error" in answer) return undefined;
    answers.set(customId, answer.data);

    const suffix = choice.recommended ? recommendation : "";
    let label = choice.label;
    if (suffix && !label.endsWith(suffix)) label += suffix;
    if (label.length > 80) {
      const numbered = `${korean ? "선택지" : "Option"} ${number}`;
      content.push(`${numbered}: ${escapeAskMarkdown(choice.label)}`);
      label = numbered + suffix;
    }
    if (!row || row.length === ROW_SIZE) {
      row = [];
      rows.push({ type: 1, components: row });
    }
    row.push({ type: 2, style: choice.recommended ? 1 : 2, label, custom_id: customId });
  }

  const instruction = korean
    ? form.acceptsPlainText
      ? "버튼을 누르거나 이 채널에 답을 입력하세요."
      : "버튼을 누르거나 이 메시지에 답장으로 답을 입력하세요."
    : form.acceptsPlainText
      ? "Click a button or type your answer in this channel."
      : "Click a button or use Discord Reply on this message to answer in text.";
  const body = content.join("\n\n");
  if (body.length + instruction.length + 2 > 2_000) return undefined;
  return { content: body, instruction, rows, answers };
}

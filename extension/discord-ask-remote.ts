import { randomUUID } from "node:crypto";
import { openDiscordAskMailbox } from "../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { isDiscordSnowflake } from "../skills/dori-mode/scripts/src/messenger/discord-inbound-state.ts";
import { Discord } from "../skills/dori-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "../skills/dori-mode/scripts/src/messenger/http.ts";
import { buildDiscordAskCard } from "./discord-ask-card.ts";
import { type AskData, parseAskAnswer, parseAskChoice, projectAskForm } from "./discord-ask-form.ts";
import { type AskButtonSocket, openAskButtons } from "./discord-ask-interactions.ts";

type AskDestination = {
  readonly channel: string;
  readonly owner: string;
  readonly receiverStateDir: string;
};
const mentions = { parse: [], replied_user: false };
const RECOMMENDATION_TIMEOUT_MS = 180_000;

export async function askOnDiscord(options: {
  readonly html: string;
  readonly route: AskDestination;
  readonly token: string;
  readonly signal: AbortSignal;
  readonly stillConnected?: (() => Promise<boolean>) | undefined;
  readonly warn: (message: string) => void;
  readonly openSocket?: AskButtonSocket | undefined;
}): Promise<{ data: AskData; timedOut?: true } | undefined> {
  const { html, route, token, stillConnected, signal, warn, openSocket } = options;
  const form = await projectAskForm(html);
  if (!form) {
    warn("This ASK form needs the local OMP dialog; nothing was posted to Discord.");
    return;
  }
  signal.throwIfAborted();
  const discord = new Discord(fetchHttp, { now: Date.now, sleep: Bun.sleep }, token);
  const path = `/channels/${route.channel}/messages`;
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const post = (content: string, reference?: string) =>
    discord.call<{ id: string }>(
      "POST",
      path,
      {
        content,
        allowed_mentions: mentions,
        nonce: randomUUID().replaceAll("-", "").slice(0, 24),
        enforce_nonce: true,
        ...(reference ? { message_reference: { message_id: reference, fail_if_not_exists: true } } : {}),
      },
      requestSignal(),
    );
  if (stillConnected && !(await stillConnected())) return;
  const question = await post("Preparing a Cataly ASK. Wait for the question before replying.");
  if (!isDiscordSnowflake(question?.id)) throw new Error("Discord did not confirm the ASK message ID");
  const questionPath = `${path}/${question.id}`;
  const mailbox = openDiscordAskMailbox(route.receiverStateDir, route.channel, question.id, route.owner);
  const seen = new Set<string>();
  let buttons: Awaited<ReturnType<typeof openAskButtons>>;
  let visibleButtons = false;
  let completion: "answered" | "timed-out" | undefined;
  let clicked: { data: AskData } | undefined;
  let correcting = false;
  const card = buildDiscordAskCard(form, `cataly-ask:${randomUUID()}`);
  const korean = /\p{Script=Hangul}/u.test(card?.content ?? form.summary);
  const recommended = form.choices?.options.filter((option) => option.recommended);
  const choice = recommended?.length === 1 ? recommended[0] : undefined;
  const recommendation = choice?.label ? parseAskChoice(form, choice.value) : undefined;
  const automatic = recommendation && "data" in recommendation ? recommendation.data : undefined;
  let closingBody = card?.content ?? `**Cataly ASK**\n${form.summary}`;
  try {
    if (card) {
      const binding = { channel: route.channel, owner: route.owner, question: question.id, answers: card.answers };
      buttons = await openAskButtons(token, binding, signal, openSocket).catch(() => undefined);
      void buttons?.answer.then((answer) => {
        clicked = answer;
      });
    }
    if (stillConnected && !(await stillConnected())) {
      warn("The Discord ASK connection changed; answer in the local dialog.");
      return;
    }
    signal.throwIfAborted();
    const instruction = form.acceptsPlainText
      ? korean
        ? "같은 채널에 답을 쓰거나 이 메시지에 답장해 주세요."
        : "Type your answer in this channel or reply to this message."
      : korean
        ? "텍스트로 답하려면 이 메시지에 답장해 주세요."
        : "Reply to this message with the answer.";
    const timeoutNotice = automatic
      ? korean
        ? "\n\n3분 동안 답변이 없으면 추천 선택지로 진행해요."
        : "\n\nIf there is no answer in 3 minutes, the recommended choice will be used."
      : "";
    const cardPrompt = card && buttons ? `${card.content}\n\n${card.instruction}${timeoutNotice}` : undefined;
    const showCard = cardPrompt !== undefined && cardPrompt.length <= 2_000;
    const prompt = showCard ? cardPrompt : `**Cataly ASK**\n${form.summary}\n\n${instruction}${timeoutNotice}`;
    if (!showCard) closingBody = `**Cataly ASK**\n${form.summary}`;
    // Arm before Discord shows the prompt, but exclude messages older than this publication attempt.
    if (form.acceptsPlainText) mailbox.refreshTextIntake();
    visibleButtons = showCard;
    await discord.call(
      "PATCH",
      questionPath,
      {
        content: prompt,
        allowed_mentions: mentions,
        ...(showCard && card ? { components: card.rows } : {}),
      },
      requestSignal(),
    );
    const autoAt = automatic ? performance.now() + RECOMMENDATION_TIMEOUT_MS : undefined;
    let routeRechecked = false;
    while (!signal.aborted) {
      if (form.acceptsPlainText) mailbox.refreshTextIntake();
      if (clicked) {
        completion = "answered";
        return clicked;
      }
      for (const reply of mailbox.replies(seen)) {
        signal.throwIfAborted();
        seen.add(reply.id);
        const answer = parseAskAnswer(form, reply.text, reply.plain);
        if ("data" in answer) {
          completion = "answered";
          return answer;
        }
        if (!correcting) {
          correcting = true;
          void post(
            `ASK answer not accepted: ${answer.error}\nReply to the original ASK message to try again.`,
            reply.id,
          )
            .catch(() => {
              if (!signal.aborted) warn("Discord did not confirm the ASK correction message.");
            })
            .finally(() => {
              correcting = false;
            });
        }
      }
      if (automatic && autoAt !== undefined && performance.now() >= autoAt && !buttons?.isSubmitting()) {
        if (stillConnected && !routeRechecked) {
          if (!(await stillConnected())) return;
          routeRechecked = true;
          // A reply can arrive while the live receiver binding is being revalidated.
          continue;
        }
        completion = "timed-out";
        return { data: automatic, timedOut: true };
      }
      await Bun.sleep(250);
    }
  } finally {
    buttons?.close();
    if (visibleButtons || completion === "timed-out") {
      const status =
        completion === "timed-out"
          ? korean
            ? "3분 동안 답변이 없어 추천 선택지로 진행했어요."
            : "No answer in 3 minutes. Proceeded with the recommended choice."
          : completion === "answered"
            ? korean
              ? "답변을 받았어요."
              : "Answer received."
            : korean
              ? "질문이 닫혔어요."
              : "This question is closed.";
      const closed = `${closingBody}\n\n${status}`;
      void discord
        .call(
          "PATCH",
          questionPath,
          {
            content: closed.length <= 2_000 ? closed : `**Cataly ASK**\n\n${status}`,
            allowed_mentions: mentions,
            components: [],
          },
          AbortSignal.timeout(3_000),
        )
        .catch(() => warn("Discord did not confirm closing the ASK card."));
    }
    mailbox.close();
  }
}

import type { Discord } from "./messenger/discord.ts";
import { MessengerError } from "./messenger/http.ts";

/** Only the known done prefix is managed. Always read the live title; never restore a saved snapshot. */
export const setThreadStatus = async (
  dc: Discord,
  id: string,
  status: string,
): Promise<{ name: string; changed: boolean }> => {
  if (status !== "done" && status !== "working") throw new MessengerError("thread status must be done or working", 400);
  const thread = await dc.channel(id);
  if (![10, 11, 12].includes(thread.type) || typeof thread.name !== "string" || !thread.name.trim())
    throw new MessengerError(`${id} is not a named Discord thread`, 400);
  const title = thread.name.replace(/^(?:\u2705 )+/, "");
  const name = status === "done" ? `\u2705 ${title}` : title;
  // setThread otherwise truncates. Status changes must not destroy any of the person's title.
  if (!name.trim() || name.length > 100)
    throw new MessengerError(
      "thread status would exceed the title limit or leave it empty; rename explicitly first",
      400,
    );
  if (name === thread.name) return { name, changed: false };
  await dc.setThread(id, { name });
  return { name, changed: true };
};

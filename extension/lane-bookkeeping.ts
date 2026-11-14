/**
 * Sol lane main agents batch required bookkeeping with real work when dependencies allow.
 * Other models, the Dori session, subagents and plain sessions are left unchanged.
 */

export interface PromptModel {
  id: string;
  name?: string;
  provider?: string;
}

const MARKER = "<omp-dori-lane-bookkeeping>";
const SOL = /(^|[/@:._\s-])gpt[._\s-]?6(?:[._\s-]1|1)[._\s-]sol(?=$|[/@:._\s-])/i;

export const LANE_BOOKKEEPING = `${MARKER}
## Lane bookkeeping rides along with work

Batch the bookkeeping already required by this task with real work whenever dependencies allow. This block adds no new bookkeeping requirements. Use footer commands only when a launch footer supplies them and the lane key; a strict one-line review without that footer keeps its output contract and must not invent a key, checkpoint, report, forward or claim.
- Emit independent calls together: a completed step's todo update, its required footer checkpoint and the next step's first real call can share a response or \`eval\` cell. Required goal creation can accompany todo initialization. Preserve every required todo, goal and journal entry.
- Chain footer commands due at the same point in one \`bash\` call with \`&&\`: checkpoint, report, forwarding its [REPORT] line, then claim-done when due. Keep the footer's live-agent and empty-input checks before forwarding, and carry report text as one data argument.
- Wait for prerequisite results before recording success. If a command fails, later commands in its chain did not run: inspect the failure and finish the outstanding bookkeeping; do not claim the partial chain completed. Same-data checkpoint retries are idempotent; never repeat a remote effect just to retry its checkpoint.
- Close out together only after the required work and evidence succeed: the final footer commands, last todo update and goal completion can share a response when their prerequisites are confirmed. If goal completion depends on claim-done, wait for that command's successful result. A failed or unconfirmed prerequisite stays open.
</omp-dori-lane-bookkeeping>`;

export const isSol = (model: PromptModel | undefined): boolean =>
  model !== undefined && (SOL.test(model.id) || (model.name !== undefined && SOL.test(model.name)));

/** The system prompt with the bookkeeping block appended, or undefined when it does not apply or is already present. */
export const withLaneBookkeeping = (systemPrompt: unknown, model: PromptModel | undefined): string[] | undefined => {
  if (!Array.isArray(systemPrompt) || !systemPrompt.every((block) => typeof block === "string")) return undefined;
  if (!isSol(model) || systemPrompt.some((block: string) => block.includes(MARKER))) return undefined;
  return [...systemPrompt, LANE_BOOKKEEPING];
};

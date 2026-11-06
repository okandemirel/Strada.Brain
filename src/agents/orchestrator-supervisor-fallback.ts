/**
 * Announce a supervisor that threw before the orchestrator hands the request
 * to one worker.
 *
 * Measured 2026-11-06 (golden run): the fallthrough wrote one log line and
 * nothing else. The user read the worker's own "Execution Plan" as though the
 * request had been planned as usual, and the task record held no trace of the
 * failure, so the owner could not see it afterwards either.
 */

import { sendChannelNotice, type IChannelSender } from "../channels/channel-core.interface.js";
import { buildSupervisorFallbackNotice } from "../supervisor/supervisor-feedback.js";
import { getLogger } from "../utils/logger.js";

export interface SupervisorFallbackTarget {
  readonly chatId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  /** The supervisor's report sink: the background executor writes it into the task's progress. */
  readonly reportUpdate?: (markdown: string) => Promise<void> | void;
}

/**
 * Write the failure into the task record (with the error) and tell the user
 * in one sentence that one agent takes the request over.
 *
 * A cancelled run is told nothing: the cancel is why the supervisor stopped,
 * and no worker takes the request over. Best-effort: a failed write or send
 * never stops the worker that runs next.
 */
export async function announceSupervisorFallback(
  channel: IChannelSender,
  target: SupervisorFallbackTarget,
  error: unknown,
): Promise<void> {
  if (target.signal?.aborted) return;
  const notice = buildSupervisorFallbackNotice(target.prompt, error);
  try {
    await target.reportUpdate?.(notice.note);
  } catch (err) {
    getLogger().debug("Supervisor fallback note was not recorded", { error: String(err) });
  }
  try {
    await sendChannelNotice(channel, target.chatId, notice.sentence);
  } catch (err) {
    getLogger().warn("Supervisor fallback notice was not delivered", { chatId: target.chatId, error: String(err) });
  }
}

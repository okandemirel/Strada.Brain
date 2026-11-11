/**
 * Announce a provider the chain benched for a refused key.
 *
 * Measured 2026-11-06 (golden run): when a seat's key was refused and the seat
 * benched for eight hours, the work finished on the next seat and the user read
 * only the answer. The task record held nothing either; the bench showed in the
 * daemon log alone, so a chain left with no spare was found by reading logs.
 *
 * Told once per bench (the health registry fires the event once). Short
 * cooldowns (503, 429) heal on their own and stay silent.
 */

import { sendChannelNotice, type IChannelSender } from "../channels/channel-core.interface.js";
import type { CredentialBenchEvent } from "../agents/providers/provider-health.js";
import { detectSupervisorFeedbackLanguage, type SupervisorFeedbackLanguage } from "../supervisor/supervisor-feedback.js";
import type { TaskManager } from "./task-manager.js";
import { SYSTEM_RUN_CHANNELS } from "./types.js";
import { getLogger } from "../utils/logger.js";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function span(ms: number, language: SupervisorFeedbackLanguage): string {
  const hours = Math.round(ms / HOUR_MS);
  if (ms >= HOUR_MS) return language === "tr" ? `${hours} saat` : `${hours} h`;
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  return language === "tr" ? `${minutes} dk` : `${minutes} min`;
}

/**
 * `sentence` is for the user; `note` is for the task record and carries the
 * refusal. The language follows the task's own prompt.
 */
export function buildProviderBenchNotice(prompt: string, event: CredentialBenchEvent): {
  sentence: string;
  note: string;
} {
  const language = detectSupervisorFeedbackLanguage(prompt);
  const length = span(event.benchedForMs, language);
  if (language === "tr") {
    const next = event.continuingOn ? `iş ${event.continuingOn} ile sürüyor` : "işi sürdürecek başka sağlayıcı kalmadı";
    return {
      sentence: `${event.provider} anahtarı reddedildi, bu oturum boyunca (${length}) devre dışı; ${next}.`,
      note: `Sağlayıcı ${event.provider} anahtar reddi nedeniyle ${length} bekletildi; ${next}. Hata: ${event.reason}`,
    };
  }
  const next = event.continuingOn ? `the work continues on ${event.continuingOn}` : "no other provider is left to continue the work";
  return {
    sentence: `${event.provider}'s key was refused, so it is set aside for this session (${length}); ${next}.`,
    note: `Provider ${event.provider} benched for ${length} after its key was refused; ${next}. Error: ${event.reason}`,
  };
}

/**
 * Write the bench into every active task's record and tell each chat once.
 * Best-effort: a failed write or send never reaches the chain that failed over.
 */
export async function announceCredentialBench(
  channel: IChannelSender,
  tasks: Pick<TaskManager, "listAllActiveTasks" | "addProgress">,
  event: CredentialBenchEvent,
): Promise<void> {
  const told = new Set<string>();
  for (const task of tasks.listAllActiveTasks()) {
    const notice = buildProviderBenchNotice(task.prompt, event);
    try {
      tasks.addProgress(task.id, notice.note);
    } catch (err) {
      getLogger().debug("Provider bench note was not recorded", { taskId: task.id, error: String(err) });
    }
    if (SYSTEM_RUN_CHANNELS.has(task.channelType) || told.has(task.chatId)) continue;
    told.add(task.chatId);
    try {
      await sendChannelNotice(channel, task.chatId, notice.sentence);
    } catch (err) {
      getLogger().warn("Provider bench notice was not delivered", { chatId: task.chatId, error: String(err) });
    }
  }
}

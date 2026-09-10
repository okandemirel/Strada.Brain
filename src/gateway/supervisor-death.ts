/**
 * What happens when the supervisor gives up.
 *
 * The supervisor restarts a crashing daemon with backoff and, after
 * maxRestarts, stops — and until now told nobody but its own log file: no
 * exit code for a service manager, no message on a channel, no trace the next
 * boot could show. For an unattended multi-day run that is the single point
 * of total failure (audited 2026-09-10: a held runtime lock or a bad .env
 * burns the ten attempts inside two minutes).
 *
 * This module writes a marker the next boot surfaces, and — when a Telegram
 * bot token and allowlist are configured — sends one message per allowed
 * user, best-effort, so the operator hears about it where they already are.
 * The supervisor process has no channels of its own; this is deliberately
 * dependency-free.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SupervisorDeathReport {
  readonly at: string;
  readonly restarts: number;
  readonly maxRestarts: number;
  readonly lastExit: { readonly code: number | null; readonly signal: string | null };
  readonly entryPoint: string;
  readonly logHint: string;
}

export interface SupervisorDeathOptions {
  readonly markerPath: string;
  readonly telegram?: { readonly token: string; readonly chatIds: readonly string[] };
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface SupervisorDeathOutcome {
  readonly markerWritten: boolean;
  readonly telegramAttempted: number;
  readonly telegramDelivered: number;
}

export function describeSupervisorDeath(report: SupervisorDeathReport): string {
  const exit = report.lastExit.signal
    ? `signal ${report.lastExit.signal}`
    : `exit code ${report.lastExit.code ?? "unknown"}`;
  return (
    `Strada.Brain supervisor stopped at ${report.at}: the daemon exited ${report.restarts + 1} times ` +
    `(limit ${report.maxRestarts}), last with ${exit}. Nothing is running until a person starts it again. ` +
    `Check ${report.logHint}.`
  );
}

/** Telegram user ids from the allowlist env value ("1,2, 3" → ["1","2","3"]). */
export function telegramChatIdsFromEnv(env: NodeJS.ProcessEnv): { token: string; chatIds: string[] } | undefined {
  const token = env["TELEGRAM_BOT_TOKEN"]?.trim();
  const ids = (env["ALLOWED_TELEGRAM_USER_IDS"] ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s));
  return token && ids.length > 0 ? { token, chatIds: ids } : undefined;
}

export async function announceSupervisorDeath(
  report: SupervisorDeathReport,
  opts: SupervisorDeathOptions,
): Promise<SupervisorDeathOutcome> {
  let markerWritten = false;
  try {
    mkdirSync(dirname(opts.markerPath), { recursive: true });
    const tmp = `${opts.markerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, opts.markerPath);
    markerWritten = true;
  } catch {
    /* the marker is best-effort; the message below may still land */
  }
  let telegramAttempted = 0;
  let telegramDelivered = 0;
  if (opts.telegram) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const text = describeSupervisorDeath(report);
    for (const chatId of opts.telegram.chatIds) {
      telegramAttempted++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${opts.telegram.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
        });
        if (res.ok) telegramDelivered++;
      } catch {
        /* one chat failing must not stop the others */
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { markerWritten, telegramAttempted, telegramDelivered };
}

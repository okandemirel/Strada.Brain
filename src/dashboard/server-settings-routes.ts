/**
 * Settings and budget API routes for the dashboard server.
 *
 * Handles:
 *   GET  /api/budget
 *   GET  /api/budget/history
 *   POST /api/budget/config
 *   GET  /api/settings/rate-limits
 *   POST /api/settings/rate-limits
 *   GET/POST /api/settings/voice
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import {
  RATE_LIMIT_SETTINGS,
  parseRateLimitValue,
  type RateLimitPatch,
  type RateLimitSettingField,
  type RateLimiter,
} from "../security/rate-limiter.js";
import { sendJson, sendJsonError } from "./server-types.js";
import type { RouteContext } from "./server-types.js";
import { z } from "zod";
import { NO_BUDGET_LIMIT } from "../budget/budget-types.js";

/**
 * POST /api/budget/config, validated as a whole before anything is stored
 * (CHN-18). BudgetConfigStore checks and persists field by field, so a body
 * with one good and one bad field stored the good one and still answered 400.
 * The rules are the store's own; a body that passes here cannot fail there
 * half-way through.
 */
const usdLimit = (field: string) =>
  z.number().min(NO_BUDGET_LIMIT, `${field} must be -1 (no limit) or a finite number >= 0`);
const BUDGET_CONFIG_BODY = z.object({
  dailyLimitUsd: usdLimit("dailyLimitUsd").optional(),
  monthlyLimitUsd: usdLimit("monthlyLimitUsd").optional(),
  warnPct: z.number().min(0.1, "warnPct must be between 0.1 and 0.99").max(0.99, "warnPct must be between 0.1 and 0.99").optional(),
  subLimits: z.object({
    daemonDailyUsd: z.number().min(0).optional(),
    agentDefaultUsd: z.number().min(0).optional(),
    verificationPct: z.number().min(0).max(1).optional(),
  }).optional(),
  interactiveTokenBudget: z.number().min(-1).optional(),
  taskReservationUsd: z.number().min(0).optional(),
});

/**
 * Boolean voice settings shared by GET and POST /api/settings/voice, as
 * [response/body field, storage override key] pairs. One table drives both
 * handlers so the field sets cannot drift.
 */
const VOICE_BOOL_FIELDS = [
  ["inputEnabled", "voice_input_enabled"],
  ["outputEnabled", "voice_output_enabled"],
  ["browserSttEnabled", "voice_browser_stt_enabled"],
] as const;

/** The little of DaemonStorage these handlers need (a test double satisfies it). */
interface SettingsOverrideStore {
  getSettingsOverride(key: string, scope?: string): string | undefined;
  setSettingsOverride(key: string, value: string, scope?: string): void;
  /**
   * DaemonStorage's SQLite transaction wrapper (`db.transaction(work).immediate()`
   * — generic, despite the name). Absent on test doubles, which then get the
   * compensating restore below.
   */
  budgetTransaction?<T>(work: () => T): T;
}

type LiveRateLimiter = Pick<RateLimiter, "updateConfig" | "getConfig">;

/**
 * THE LIMITS IN FORCE (round 9 #22).
 *
 * The GET used to answer `Number(storedOverride ?? "0")`, so a daemon whose
 * limits came from configuration — 10 messages/minute, 100/hour — reported
 * zeros. The portal loads that body, the person edits ONE field, and the
 * whole-body POST writes the zeros over the other two: editing the token quota
 * disabled both message limits (reproduced).
 *
 * The answer is the RUNNING limiter's own configuration, which is the
 * configured values with the stored overrides already applied at startup
 * (applyStoredRateLimitOverrides). Without a limiter nothing is enforced at
 * all, so the stored override — when it is a legal limit — is the best
 * description of what the next boot will enforce, and 0 ("unlimited") is the
 * honest answer otherwise.
 */
export function effectiveRateLimits(
  storage: SettingsOverrideStore,
  limiter?: LiveRateLimiter,
): Record<RateLimitSettingField, number> {
  const live = limiter?.getConfig();
  return Object.fromEntries(
    RATE_LIMIT_SETTINGS.map(({ field, storageKey }) => {
      if (live) return [field, live[field]];
      const raw = storage.getSettingsOverride(storageKey);
      const parsed = raw === undefined ? undefined : parseRateLimitValue(field, raw);
      // A corrupt row is not a limit: it must not be reported as one, exactly
      // as applyStoredRateLimitOverrides refuses to enforce it.
      return [field, parsed?.ok === true ? parsed.value : 0];
    }),
  ) as Record<RateLimitSettingField, number>;
}

/**
 * PERSIST, THEN PUBLISH (round 9 #23).
 *
 * The POST used to hand the patch to the live limiter first and then write the
 * rows one at a time. A failure on the second write returned an error while
 * BOTH live limits had already changed and only the first override was
 * persisted — so a restart produced a third configuration. The rows are written
 * as one transaction and the running limiter is told only once they are
 * committed; a store without transaction support gets a compensating restore.
 *
 * Throws when nothing could be committed: the caller answers with an error and
 * both the store and the enforced policy are exactly as they were.
 */
export function commitRateLimitPatch(
  storage: SettingsOverrideStore,
  patch: RateLimitPatch,
  limiter?: LiveRateLimiter,
): void {
  const fields = RATE_LIMIT_SETTINGS.filter(({ field }) => patch[field] !== undefined);
  if (fields.length === 0) return;
  const effectiveBefore = limiter?.getConfig();
  // What each row said before. A row that did not exist cannot be deleted
  // again, so its "before" is the value that was IN FORCE — the stored form of
  // "this request changed nothing".
  const before = fields.map(({ field, storageKey }) => [
    storageKey,
    storage.getSettingsOverride(storageKey) ?? String(effectiveBefore?.[field] ?? 0),
  ] as const);
  const writeAll = (): void => {
    for (const { field, storageKey } of fields) {
      storage.setSettingsOverride(storageKey, String(patch[field]));
    }
  };
  const restore = (): void => {
    for (const [key, value] of before) {
      try {
        storage.setSettingsOverride(key, value);
      } catch {
        // Nothing further is possible; the thrown error is what the caller reports.
      }
    }
  };

  if (typeof storage.budgetTransaction === "function") {
    // Every row or none: SQLite rolls the earlier writes back on a throw.
    storage.budgetTransaction(writeAll);
  } else {
    try {
      writeAll();
    } catch (err) {
      restore();
      throw err;
    }
  }

  try {
    // AFTER the commit. Every value already passed the limiter's own gate
    // (parseRateLimitValue, the same table it re-validates with), so this
    // cannot refuse a committed patch — and if it ever did, the store must not
    // be left describing a policy the daemon is not enforcing.
    limiter?.updateConfig(patch);
  } catch (err) {
    restore();
    throw err;
  }
}

/**
 * Try to handle settings and budget routes. Returns true if the route was handled.
 */
export function handleSettingsRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  // GET /api/budget -- Budget snapshot + config
  if (url === "/api/budget" || url.startsWith("/api/budget?")) {
    if (!ctx.unifiedBudgetManager) {
      sendJsonError(res, 503, "Budget manager not available");
      return true;
    }
    try {
      const snapshot = ctx.unifiedBudgetManager.getSnapshot();
      const config = ctx.unifiedBudgetManager.getConfig();
      sendJson(res, { ...snapshot, config });
    } catch (err) {
      sendJsonError(res, 500, err instanceof Error ? err.message : "Budget snapshot failed");
    }
    return true;
  }

  // GET /api/budget/history -- Daily spend history
  if (url.startsWith("/api/budget/history")) {
    if (!ctx.unifiedBudgetManager) {
      sendJsonError(res, 503, "Budget manager not available");
      return true;
    }
    const params = new URL(url, "http://localhost").searchParams;
    const days = Math.min(Math.max(parseInt(params.get("days") ?? "7", 10), 1), 30);
    const entries = ctx.unifiedBudgetManager.getDailyHistory(days);
    sendJson(res, { entries });
    return true;
  }

  // POST /api/budget/config -- Update budget configuration
  if (url === "/api/budget/config" && method === "POST") {
    if (!ctx.unifiedBudgetManager) {
      sendJsonError(res, 503, "Budget manager not available");
      return true;
    }
    void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
      if (!parsed) return; // readJsonBody already sent the error response
      // CHN-18: validate the WHOLE body before anything is stored (see schema).
      const body = BUDGET_CONFIG_BODY.safeParse(parsed);
      if (!body.success) {
        const issue = body.error.issues[0];
        sendJsonError(res, 400, issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid budget configuration");
        return;
      }
      try {
        ctx.unifiedBudgetManager!.updateConfig(body.data as Parameters<UnifiedBudgetManager["updateConfig"]>[0]);
        sendJson(res, { success: true, config: ctx.unifiedBudgetManager!.getConfig() });
      } catch (err) {
        sendJsonError(res, 400, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // GET /api/settings/rate-limits -- Read rate limit overrides
  if ((url === "/api/settings/rate-limits" || url.startsWith("/api/settings/rate-limits?")) && (method === "GET" || !method)) {
    if (!ctx.daemonStorage) {
      sendJsonError(res, 503, "Storage not available");
      return true;
    }
    // One table for GET, POST and the startup restore (RATE_LIMIT_SETTINGS) so
    // the three cannot drift — the tokensPerDay field once round-tripped
    // through a key nothing read. The values are the EFFECTIVE limits, not a
    // bare storage read (round 9 #22).
    sendJson(res, effectiveRateLimits(ctx.daemonStorage, ctx.rateLimiter));
    return true;
  }

  // POST /api/settings/rate-limits -- Save rate limit overrides
  if (url === "/api/settings/rate-limits" && method === "POST") {
    if (!ctx.daemonStorage) {
      sendJsonError(res, 503, "Storage not available");
      return true;
    }
    void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
      if (!parsed) return;
      try {
        const storage = ctx.daemonStorage!;
        // VALIDATE THE WHOLE BODY FIRST. Until item 2.7 the handler wrote
        // `String(parsed.x)` for whatever arrived, so "abc", -5 and 1e15 all
        // became the stored (and later enforced) limit. A bad field must leave
        // the store and the live limiter exactly as they were, so nothing is
        // written until every submitted field has passed.
        const patch: RateLimitPatch = {};
        for (const { field } of RATE_LIMIT_SETTINGS) {
          const raw = parsed[field];
          if (raw === undefined) continue;
          const value = parseRateLimitValue(field, raw);
          if (!value.ok) {
            sendJsonError(res, 400, `Invalid rate limit — ${value.error}`);
            return;
          }
          patch[field] = value.value;
        }

        // ONE COMMIT, THEN the live limiter (round 9 #23). Writing the rows one
        // by one with the limiter already changed meant a mid-way failure
        // returned an error while the daemon enforced the new numbers and the
        // store held half of them. The keys are the ones the GET reads
        // (rate_limit_tokens_per_day) and the frontend sends (tokensPerDay):
        // the previous daily key was never read, so it always reloaded as 0.
        commitRateLimitPatch(storage, patch, ctx.rateLimiter);
        sendJson(res, { success: true });
      } catch (err) {
        // A refused NUMBER is the client's fault (400); a store that could not
        // commit is ours (500) — and in both cases nothing changed.
        const status = err instanceof RangeError ? 400 : 500;
        sendJsonError(res, status, err instanceof Error ? err.message : String(err));
      }
    });
    return true;
  }

  // GET/POST /api/settings/voice -- Voice settings per chatId scope
  if (url === "/api/settings/voice" || url.startsWith("/api/settings/voice?")) {
    if (!ctx.daemonStorage) {
      sendJsonError(res, 503, "Storage not available");
      return true;
    }
    const voiceParams = new URL(url, "http://localhost").searchParams;
    const chatId = voiceParams.get("chatId") ?? "global";

    if (method === "GET" || method === "HEAD") {
      const storage = ctx.daemonStorage;
      const enabled = storage.getSettingsOverride("voice_enabled", chatId);
      const language = storage.getSettingsOverride("voice_language", chatId);
      const speed = storage.getSettingsOverride("voice_speed", chatId);
      const voiceBools = Object.fromEntries(
        VOICE_BOOL_FIELDS.map(([field, key]) => {
          const raw = storage.getSettingsOverride(key, chatId);
          return [field, raw !== undefined ? raw === "true" : null];
        }),
      );
      sendJson(res, {
        enabled: enabled !== undefined ? enabled === "true" : null,
        language: language ?? null,
        speed: speed !== undefined ? parseFloat(speed) : null,
        ...voiceBools,
        chatId,
      });
      return true;
    }

    if (method === "POST") {
      void ctx.readJsonBody<Record<string, unknown>>(req, res).then((parsed) => {
        if (!parsed) return;
        try {
          const storage = ctx.daemonStorage!;
          if (parsed.enabled !== undefined) {
            storage.setSettingsOverride("voice_enabled", String(Boolean(parsed.enabled)), chatId);
          }
          if (parsed.language !== undefined) {
            storage.setSettingsOverride("voice_language", String(parsed.language), chatId);
          }
          if (parsed.speed !== undefined) {
            storage.setSettingsOverride("voice_speed", String(parsed.speed), chatId);
          }
          for (const [field, key] of VOICE_BOOL_FIELDS) {
            const value = parsed[field];
            if (typeof value === "boolean") {
              storage.setSettingsOverride(key, String(value), chatId);
            }
          }
          sendJson(res, { success: true });
        } catch (err) {
          sendJsonError(res, 400, err instanceof Error ? err.message : String(err));
        }
      });
      return true;
    }

    sendJsonError(res, 405, "Method not allowed");
    return true;
  }

  return false;
}

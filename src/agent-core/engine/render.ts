/**
 * Agent Core v2 — engine rendering (relocation Step 6a; blueprint: project_v2_engine_relocation).
 *
 * The terminal/boundary rendering leaf of the port + interactive driver: emit the visible boundary
 * answer, sanitize a blocked-visible-text, render the interactive budget-exceeded notice, and map a
 * spine resilience AgentEvent to the interactive channel. Moved VERBATIM from orchestrator.ts.
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.ts.
 */

import type { Session, SessionManager } from "../../agents/orchestrator-session-manager.js";
import type { UserProfileStore } from "../../memory/unified/user-profile-store.js";
import type { AgentEvent } from "../events/agent-event.js";
import { getResilienceMessage } from "../../agents/resilience-messages.js";
import { getLogger } from "../../utils/logger.js";
import type { EngineRunContext } from "./engine-deps.js";
import { getLiveInteractiveTokenBudget, type BudgetDeps } from "./budget.js";

/** Copies of the shell's loop-block detection const + the interactive non-abort run-ending reasons
 *  (both still used in the shell; transitional duplication until Steps 7-9 finish the relocation). */
const DIAGNOSTIC_BLOCKED_RE = /^Blocked checkpoint:/i;
const INTERACTIVE_NON_ABORT_RUN_ENDING_REASONS: ReadonlySet<string> = new Set([
  "done",
  "completed",
  "blocked",
  "end_turn",
  "max-tokens-runaway",
  "blocked:ask_user",
  "epoch-budget-exhausted",
  "plan-review",
  "goal-handoff",
  "budget-exhausted:tokens",
]);

/** The dependency slice the rendering cluster reads (grows only with this module). */
export interface RenderDeps extends BudgetDeps {
  readonly sessionManager: SessionManager;
  readonly userProfileStore?: UserProfileStore;
  readonly defaultLanguage: string;
}

export function sanitizeBlockedVisibleText(
  deps: RenderDeps,
  raw: string,
): { text: string; marked: boolean } {
  if (!raw) return { text: "", marked: false };
  if (!DIAGNOSTIC_BLOCKED_RE.test(raw)) return { text: raw, marked: false };
  getLogger().warn("Loop detection blocked task", { diagnostic: raw.slice(0, 500) });
  const stuckMsg = getResilienceMessage("task_stuck", deps.defaultLanguage);
  const actionMatch = /Suggested action:\s*(.+?)(?:\nFiles t|$)/is.exec(raw);
  const text = actionMatch?.[1]?.trim()
    ? `${stuckMsg}\n\n**${actionMatch[1].trim()}**`
    : stuckMsg;
  return { text, marked: true };
}

/**
 * Sanitize a handler's visible text and, when non-empty, render it to the channel; returns the
 * sanitized {text, marked} so callers apply the loop-block mark. Centralizes the sanitize→emit
 * boundary the reflection + end-turn dispatch arms shared (4 copies → 1).
 */
export async function emitVisibleBoundary(
  deps: RenderDeps,
  chatId: string,
  session: Session,
  visibleText: string | undefined,
): Promise<{ text: string; marked: boolean }> {
  const safe = sanitizeBlockedVisibleText(deps, visibleText ?? "");
  if (safe.text) {
    await deps.sessionManager.sendVisibleAssistantMarkdown(chatId, session, safe.text);
  }
  return safe;
}

/**
 * 3.3 — render the SPECIFIC `token_budget_exceeded` notice on the interactive token-budget stop (v1
 * runAgentLoop:5491 parity), instead of the generic provider_abort. {used} = the run's cumulative
 * OUTPUT tokens (the "fresh work" metric; input re-counts the growing context — audit #3); {budget} =
 * the live interactive cap (== the enforced static cap for the common no-mid-task-change case).
 * Localized via the user profile (v1 used the same). The checkpoint is already saved by the spine.
 */
export async function portRenderInteractiveBudgetExceeded(
  deps: RenderDeps,
  runCtx: EngineRunContext,
): Promise<void> {
  const tokenBudget = getLiveInteractiveTokenBudget(deps);
  const language = (deps.userProfileStore?.getProfile?.(runCtx.identityKey)?.language ??
    deps.defaultLanguage) as string;
  await deps.sessionManager.sendVisibleAssistantMarkdown(
    runCtx.chatId,
    runCtx.session,
    getResilienceMessage("token_budget_exceeded", language, {
      used: Math.round(runCtx.cumulativeOutputTokens / 1000),
      budget: Math.round(tokenBudget / 1000),
    }),
  );
}

/**
 * Agent Core v2 (Step 3 / increment 3.2) — render the spine's user-facing resilience events to the
 * INTERACTIVE channel. This is the v2 analog of {@link applyInteractiveVerdict}'s rendering arm
 * (:1459-1487): on the v2 path the spine emits typed `AgentEvent`s through the bus→ioSink→onEvent
 * seam, and without translating them the user sees NOTHING when a provider backs off, asks, or the
 * run aborts — a UX regression vs v1. Mapping (robust: keyed on event type/status, never a humanized
 * reason string):
 *   - `backoff`   → `provider_slow` (v1 degraded tier, :1462). The event carries no failure
 *                   count/tier, so the no-param degraded message is rendered; the critical-tier
 *                   `provider_failing {attempt}/{max}` is deferred to a backoff-event enrichment.
 *   - `ask_user`  → the model's own `visibleText` when present, else `provider_ask_user` (:1478).
 *   - `show_plan` → `visibleText` verbatim (the plan body, not a resilience string).
 *   - `run.ending` whose reason is a control-plane STOP → `provider_abort` (v1's ledger-break
 *                   render, :1485). The reason carries the terminal cause; every value NOT in
 *                   {@link INTERACTIVE_NON_ABORT_RUN_ENDING_REASONS} (done/end_turn/max-tokens/
 *                   ask-block/epoch) is a stop. The happy `end_turn`/`done` already had the answer
 *                   rendered by the port dispatch (3.0), so they are skipped — no double-render.
 *                   (Empirically: a rule-4 inactivity stop is a SOFT stop → terminalStatus
 *                   "completed", so keying on `run.ended.status==="failed"` would MISS it; the
 *                   reason on `run.ending` is the faithful break signal.)
 * Everything else (lifecycle, heartbeat, model/tool streaming deltas, run.started/ending, step.x) is
 * a no-op here — not user-facing on the interactive path. The TERMINAL ANSWER is never rendered here
 * (the port's dispatch handlers own it); this strictly handles non-answer signals.
 *
 * `e` is typed `AgentEvent` but arrives via the `AgentRunEvent`-typed `onEvent` (the deferred
 * AgentEvent→TaskProgressUpdate seam — control-plane.ts), so the caller casts at the boundary.
 * `enqueue` appends the render to an ordered tail-promise chain (the caller drains it post-run);
 * v1-faithful, this does NOT throttle — one message per event, as applyInteractiveVerdict does.
 */
export function renderInteractiveResilienceEvent(
  e: AgentEvent,
  language: string,
  enqueue: (text: string, transient?: boolean) => void,
): void {
  switch (e.type) {
    case "backoff":
      // Transient mid-run status (v1 degraded tier) — `transient:true` routes it
      // to a system pill, NOT the transcript. Every other arm below is a terminal
      // explanation (abort/max-iterations) or an interactive prompt (ask_user/
      // show_plan) and stays a recorded, visible answer.
      enqueue(getResilienceMessage("provider_slow", language), true);
      return;
    case "ask_user":
      enqueue(
        e.visibleText.trim().length > 0
          ? e.visibleText
          : getResilienceMessage("provider_ask_user", language),
      );
      return;
    case "show_plan":
      enqueue(e.visibleText);
      return;
    case "run.ending":
      if (e.reason === "max-iterations") {
        // 3.4: the interactive run exhausted its step budget — render the "send a follow-up" notice
        // (v1 runAgentLoop "Hit max iterations" parity), NOT a provider_abort. Localized via the
        // resilience key (v1 hardcoded English). Dedicated arm — NOT a skip-set entry (the skip-set
        // means "already rendered, do nothing"; here we render a specific notice).
        enqueue(getResilienceMessage("max_steps_reached", language));
        return;
      }
      if (!INTERACTIVE_NON_ABORT_RUN_ENDING_REASONS.has(e.reason)) {
        enqueue(getResilienceMessage("provider_abort", language));
      }
      return;
    default:
      return;
  }
}

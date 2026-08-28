/**
 * Process-wide tool-activity relay, keyed by chatId.
 *
 * The stuck-task reaper measures a task's `updated_at`, but tool executions in a
 * decomposed wave run on WORKER orchestrator instances (agent-manager,
 * delegation-manager) whose per-instance `onLiveness` slot nothing ever sets.
 * Measured 2026-08-29: two campaign tasks were reaped at exactly 60 minutes with
 * zero progress rows while their workers ran tools the whole time — the
 * heartbeat existed only on the top-level orchestrator singleton.
 *
 * Every orchestrator instance reports tool activity here with the chatId it
 * already has in hand; the background executor subscribes with the task's
 * chatId, so a worker's tool call keeps the parent task alive no matter which
 * instance ran it. Module-level state is the point: instances must not need a
 * shared object threaded through their constructors to be counted.
 */

type LivenessListener = () => void;

const listeners = new Map<string, Set<LivenessListener>>();
const lastNotifyAt = new Map<string, number>();

/** Floor between notifications per chatId — tool bursts collapse to one touch. */
const NOTIFY_MIN_INTERVAL_MS = 20_000;

/**
 * Register a listener for tool activity on a chat. Returns an unsubscribe
 * function; callers MUST run it when the task settles or the map leaks the
 * closure (and with it the task) for the life of the process.
 */
export function subscribeTaskLiveness(chatId: string, listener: LivenessListener): () => void {
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(chatId);
      lastNotifyAt.delete(chatId);
    }
  };
}

/**
 * Report tool activity on a chat. Throttled per chatId; listener errors are
 * swallowed — liveness accounting must never break the tool that reported it.
 */
export function notifyTaskLiveness(chatId: string): void {
  const set = listeners.get(chatId);
  if (!set || set.size === 0) return;
  const now = Date.now();
  const last = lastNotifyAt.get(chatId) ?? 0;
  if (now - last < NOTIFY_MIN_INTERVAL_MS) return;
  lastNotifyAt.set(chatId, now);
  for (const listener of set) {
    try {
      listener();
    } catch {
      // Never let a broken listener take down tool execution.
    }
  }
}

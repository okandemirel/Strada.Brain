/**
 * Which run do these retrieved instincts belong to?
 *
 * audited 2026-09-02: the per-run set of matched instinct IDs — the set every
 * `tool:result` is attributed to, and the set the trajectory credit reinforces —
 * was stored under the chatId alone. Every supervisor wave node runs on the one
 * Orchestrator with the one chatId (createSupervisorExecuteNodeBridge), so
 * concurrent nodes overwrote one another: the last node's instincts collected
 * every other node's outcomes, and the first node to tear down deleted the set
 * out from under its siblings, whose remaining results then carried nothing.
 *
 * The run scope is the taskRunId the bridge already stamps per node (and the
 * spine's ALS context carries for the whole run). Off-run — no context, a v1
 * revert path — the conversation is still the honest scope, so the key falls
 * back to the chatId and behaviour there is unchanged.
 *
 * The NUL separator matches the Orchestrator's other run-scoped keys, so a
 * conversation's entries stay sweepable by chatId prefix.
 */
export function instinctScopeKey(chatId: string, taskRunId?: string): string {
  const run = taskRunId?.trim();
  return run ? `${chatId}\u0000${run}` : chatId;
}

// ---------------------------------------------------------------------------
// The scope directive every plan node's worker receives.
//
// Measured 2026-09-09 14:12-14:40 on the user's project: a node whose whole
// task was "Run unity_delivery_measure … output the list" made the call at
// 14:15, then spent 25 minutes reading set-piece views and tests, writing two
// files and running unity_verify_change — work no node had asked for, on a
// budget the batch nodes behind it needed. The node prompt carried the task,
// its completed dependencies and its time budget, but nothing that said
// "this task and nothing else".
// ---------------------------------------------------------------------------

export const NODE_SCOPE_DIRECTIVE = [
  "## Scope of this node",
  "You are executing ONE node of a larger plan. Do exactly what this node says and nothing else:",
  "no reading, refactoring, testing or fixing outside it, and no exploring the project \"to understand it first\".",
  "If the node names a tool, call that tool — its output is the deliverable; report it verbatim.",
  "Anything else you notice belongs in one sentence of your final answer, not in your actions.",
  "When the node's deliverable exists, stop and answer.",
].join("\n");

/** The node task plus the scope directive (dependencies and budget are appended by the bridge). */
export function withNodeScope(nodePrompt: string): string {
  return `${nodePrompt}\n\n${NODE_SCOPE_DIRECTIVE}`;
}

/**
 * Evidence a task demanded by name, checked against what actually ran.
 *
 * Measured 2026-09-10 18:17: a mission whose prompt said "run unity_playthrough
 * … a verdict that is not ok is not done" completed in three minutes with a
 * final answer after a unity_verify_change, and the cross-provider verifier
 * approved it — the play-through never ran in that node. The worker's words
 * were the only evidence. A tool the task names with "run" is a mechanical
 * requirement: a successful call of it must be in the node's own trace, or
 * the node is not done, whatever the report says. Nothing here knows a game's
 * names — it reads the task's own sentence.
 */

/** Tools the task's text tells the worker to run: "run unity_playthrough", "Run the unity_build_player". */
export function requiredToolsInPrompt(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/\brun\s+(?:the\s+)?(unity_[a-z0-9_]+)/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}

export interface EvidenceShortfall {
  readonly tool: string;
  readonly attempts: number;
}

/** Required tools without a successful call in the trace, with how many times each was tried. */
export function missingRequiredEvidence(
  prompt: string,
  trace: ReadonlyArray<{ readonly toolName: string; readonly success: boolean }>,
): EvidenceShortfall[] {
  const required = requiredToolsInPrompt(prompt);
  const shortfalls: EvidenceShortfall[] = [];
  for (const tool of required) {
    const calls = trace.filter((t) => t.toolName === tool);
    if (calls.some((t) => t.success)) continue;
    shortfalls.push({ tool, attempts: calls.length });
  }
  return shortfalls;
}

/** The sentence a rejected node carries, naming each missing proof. */
export function describeEvidenceShortfall(shortfalls: readonly EvidenceShortfall[]): string {
  return (
    "REQUIRED EVIDENCE MISSING: " +
    shortfalls
      .map((s) => `the task says run ${s.tool}; ${s.attempts === 0 ? "it never ran in this node" : `${s.attempts} run(s), none ok`}`)
      .join("; ") +
    " — the result is not done whatever the report says."
  );
}

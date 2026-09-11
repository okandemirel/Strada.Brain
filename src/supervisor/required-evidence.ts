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
  // "run X", "execute X", "invoke X", "call X", "use X", "using X", "via X",
  // "through X" — with up to a few words between ("run the full suite using
  // unity_test_run"). "run X" alone let "execute unity_x" through (Codex
  // 2026-09-11 B#13).
  for (const m of prompt.matchAll(/\b(?:run|execute|invoke|call|use|using|via|through)\b(?:\s+(?!unity_)[a-z'-]+){0,4}\s+(unity_[a-z0-9_]+)/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}

export interface EvidenceShortfall {
  readonly tool: string;
  readonly attempts: number;
  /** Set when the tool RAN but not the way the task named it. */
  readonly argument?: { readonly key: string; readonly value: string };
}

export interface RequiredToolArgument {
  readonly tool: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Arguments the task names beside a tool: `run unity_playthrough with
 * sessions "all"`. Only quoted scalars, only within the same sentence as the
 * tool, so an ordinary mention cannot manufacture a requirement.
 */
export function requiredToolArguments(prompt: string): RequiredToolArgument[] {
  const out: RequiredToolArgument[] = [];
  const seen = new Set<string>();
  const re = /\b(?:run|execute|invoke|call|use|using|via|through)\b(?:\s+(?!unity_)[a-z'-]+){0,4}\s+(unity_[a-z0-9_]+)([^.\n]{0,120})/gi;
  for (const m of prompt.matchAll(re)) {
    const tool = m[1]!.toLowerCase();
    for (const a of (m[2] ?? "").matchAll(/\b([a-z][a-zA-Z0-9_]{2,20})\s*[:=]?\s*"([^"]{1,40})"/g)) {
      const key = `${tool}:${a[1]!.toLowerCase()}:${a[2]!.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tool, key: a[1]!, value: a[2]! });
    }
  }
  return out;
}

/** Required tools without a successful call in the trace, with how many times each was tried. */
export function missingRequiredEvidence(
  prompt: string,
  trace: ReadonlyArray<{ readonly toolName: string; readonly success: boolean; readonly args?: string }>,
): EvidenceShortfall[] {
  const required = requiredToolsInPrompt(prompt);
  const shortfalls: EvidenceShortfall[] = [];
  for (const tool of required) {
    const calls = trace.filter((t) => t.toolName === tool);
    if (!calls.some((t) => t.success)) {
      shortfalls.push({ tool, attempts: calls.length });
      continue;
    }
    // The tool RAN — now: the way the task named it? A trace row that
    // recorded no arguments cannot contradict the task, so it passes.
    for (const want of requiredToolArguments(prompt)) {
      if (want.tool !== tool) continue;
      const withArgs = calls.filter((t) => t.success && typeof t.args === "string");
      if (withArgs.length === 0) continue;
      if (withArgs.some((t) => argSatisfies(t.args!, want.key, want.value))) continue;
      shortfalls.push({ tool, attempts: calls.length, argument: { key: want.key, value: want.value } });
    }
  }
  return shortfalls;
}

/** Does this recorded argument object carry `key` with `value` (case-insensitive)? */
export function argSatisfies(args: string, key: string, value: string): boolean {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k.toLowerCase() !== key.toLowerCase()) continue;
      return String(v).toLowerCase() === value.toLowerCase();
    }
    return false;
  } catch {
    return false;
  }
}

/** The sentence a rejected node carries, naming each missing proof. */
export function describeEvidenceShortfall(shortfalls: readonly EvidenceShortfall[]): string {
  return (
    "REQUIRED EVIDENCE MISSING: " +
    shortfalls
      .map((s) => s.argument
        ? `the task says run ${s.tool} with ${s.argument.key} "${s.argument.value}"; it ran, but no successful call used that argument`
        : `the task says run ${s.tool}; ${s.attempts === 0 ? "it never ran in this node" : `${s.attempts} run(s), none ok`}`)
      .join("; ") +
    " — the result is not done whatever the report says."
  );
}

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
/**
 * Words that make an instruction CONDITIONAL: the tool runs only in a case
 * that may not arise.
 *
 * Measured live 2026-09-11 18:34 onward: a mission said "call
 * unity_generate_sprite … repeat batches until the measured count is below
 * 200". The count was already 0, so the run correctly generated nothing — and
 * this gate failed the node for a call the situation did not call for, every
 * round, for hours. A gate that demands an action the work does not need is
 * the unsatisfiable gate this whole review week has been about.
 *
 * "until it passes" is NOT in here: that governs how often, not whether.
 */
const CONDITIONAL_RE =
  /\b(?:if|unless|as needed|if needed|where necessary|only\s+(?:if|when)|in case)\b/i;

/**
 * A procedure that REPEATS UNTIL A MEASURED THRESHOLD: "repeat batches until
 * the measured count is below 200". When the threshold already holds, the
 * work inside the loop correctly does not run, so the tools named inside it
 * cannot each be demanded — but the node must still have MEASURED something,
 * which is what the rule below keeps.
 */
const THRESHOLD_LOOP_RE =
  /\b(?:repeat|loop|continue|keep going|again)\b[^.\n]{0,80}?\buntil\b[^.\n]{0,80}?\b(?:below|under|fewer|less than|at most|reaches|drops|<=?|zero|none)\b/i;

/** The sentence `at` sits in, for judging whether its instruction is conditional. */
function sentenceAround(text: string, at: number): string {
  const from = Math.max(text.lastIndexOf(".", at), text.lastIndexOf("\n", at)) + 1;
  const dot = text.indexOf(".", at);
  const nl = text.indexOf("\n", at);
  const ends = [dot, nl].filter((i) => i >= 0);
  const to = ends.length > 0 ? Math.min(...ends) : text.length;
  return text.slice(from, to);
}

export function requiredToolsInPrompt(prompt: string): string[] {
  const out = new Set<string>();
  // "run X", "execute X", "invoke X", "call X", "use X", "using X", "via X",
  // "through X" — with up to a few words between ("run the full suite using
  // unity_test_run"). "run X" alone let "execute unity_x" through (Codex
  // 2026-09-11 B#13).
  const conditional = new Set<string>();
  for (const m of prompt.matchAll(/\b(?:run|execute|invoke|call|use|using|via|through)\b(?:\s+(?!unity_)[a-z'-]+){0,4}\s+(unity_[a-z0-9_]+)/gi)) {
    const tool = m[1]!.toLowerCase();
    // A tool named in a CONDITIONAL instruction is required only when that
    // condition holds, and nothing here can judge that — so it is reported as
    // conditional rather than demanded.
    if (CONDITIONAL_RE.test(sentenceAround(prompt, m.index ?? 0))) conditional.add(tool);
    else out.add(tool);
  }
  for (const tool of conditional) out.delete(tool);
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
  // The tool, then only what follows it up to the next tool name: "…with
  // target \"android\"" after unity_build_player is not unity_playthrough's
  // argument (Codex 2026-09-11 D#14).
  const calls = [...prompt.matchAll(/\b(?:run|execute|invoke|call|use|using|via|through)\b(?:\s+(?!unity_)[a-z'-]+){0,4}\s+(unity_[a-z0-9_]+)/gi)];
  for (let c = 0; c < calls.length; c++) {
    const m = calls[c]!;
    const tool = m[1]!.toLowerCase();
    const from = (m.index ?? 0) + m[0].length;
    const to = Math.min(calls[c + 1]?.index ?? prompt.length, from + 160, sentenceEnd(prompt, from));
    const window = prompt.slice(from, to);
    // KNOWN argument names only: an arbitrary word before a quote turned
    // `report "all good"` into a requirement (D#14).
    for (const a of window.matchAll(/\b(sessions|filter|categories|target|scene|mode|platform|capture|provider)\b\s*[:=]?\s*"([^"]{1,40})"/gi)) {
      const key = a[1]!.toLowerCase();
      const value = a[2]!.trim();
      if (value === "" || /^[:{}\[\],]+$/.test(value)) continue; // JSON punctuation, not a value
      const id = `${tool}:${key}:${value.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ tool, key, value });
    }
    // A bare flag the campaign's own directives use: "run the FULL suite
    // UNFILTERED using unity_test_run" (D#11). The window looks backwards too,
    // because the flag usually precedes the tool.
    const flagWindow = prompt.slice(Math.max(0, (m.index ?? 0) - 120), to);
    if (/\bunfiltered\b/i.test(flagWindow)) {
      const id = `${tool}:unfiltered:true`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ tool, key: "unfiltered", value: "true" });
      }
    }
  }
  return out;
}

function sentenceEnd(text: string, from: number): number {
  const stop = text.slice(from).search(/[.\n]/);
  return stop === -1 ? text.length : from + stop;
}

/** Required tools without a successful call in the trace, with how many times each was tried. */
export function missingRequiredEvidence(
  prompt: string,
  trace: ReadonlyArray<{ readonly toolName: string; readonly success: boolean; readonly args?: string }>,
): EvidenceShortfall[] {
  const required = requiredToolsInPrompt(prompt);
  const shortfalls: EvidenceShortfall[] = [];
  // A THRESHOLD LOOP's tools are demanded as a SET, not one by one: when the
  // threshold already holds the loop body correctly does not run, and
  // demanding each named tool failed the node for work the situation did not
  // call for — measured live 2026-09-11, a mission whose target was already
  // met failed this gate every round for hours. One successful call of a
  // named tool is the evidence that the node did the measuring; a node that
  // ran none of them is still rejected.
  const loopThreshold = THRESHOLD_LOOP_RE.test(prompt);
  const ranSomething = required.some((tool) => trace.some((t) => t.toolName === tool && t.success));
  for (const tool of required) {
    const calls = trace.filter((t) => t.toolName === tool);
    if (!calls.some((t) => t.success)) {
      if (loopThreshold && ranSomething) continue;
      shortfalls.push({ tool, attempts: calls.length });
      continue;
    }
    // The tool RAN — now: the way the task named it? ONE call must satisfy
    // EVERY argument the task named for this tool; separate calls used to
    // manufacture a combination neither of them made (Codex 2026-09-11 D#10).
    // A trace row that recorded no arguments cannot contradict the task.
    const wants = requiredToolArguments(prompt).filter((w) => w.tool === tool);
    if (wants.length === 0) continue;
    const withArgs = calls.filter((t) => t.success && typeof t.args === "string");
    if (withArgs.length === 0) continue;
    const satisfied = withArgs.some((t) => wants.every((w) => argSatisfies(t.args!, w.key, w.value)));
    if (satisfied) continue;
    const firstUnmet = wants.find((w) => !withArgs.some((t) => argSatisfies(t.args!, w.key, w.value))) ?? wants[0]!;
    shortfalls.push({ tool, attempts: calls.length, argument: { key: firstUnmet.key, value: firstUnmet.value } });
  }
  return shortfalls;
}

/** Does this recorded argument object carry `key` with `value` (case-insensitive)? */
export function argSatisfies(args: string, key: string, value: string): boolean {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k.toLowerCase() !== key.toLowerCase()) continue;
      const got = String(v).toLowerCase();
      const want = value.toLowerCase();
      // "unfiltered" is satisfied by the flag being true OR by the run
      // carrying no filter at all.
      if (key.toLowerCase() === "unfiltered") return got === "true" || got === want;
      return got === want;
    }
    // The key is absent. For a flag, absence is not proof either way and the
    // sibling keys decide; for a named value, the call did not use it.
    if (key.toLowerCase() === "unfiltered") {
      return !("filter" in parsed) && !("categories" in parsed);
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

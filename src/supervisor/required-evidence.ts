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

/**
 * Where one instruction ends and the next begins.
 *
 * The full stop and the newline are not the only boundaries people write:
 * "Run unity_playthrough; if it fails, run unity_playthrough again." is two
 * instructions, and judging the whole line as one made the conditional clause
 * govern the unconditional one — the prompt then required nothing at all
 * (Codex 2026-09-12 P#4).
 */
const CLAUSE_BREAK = /[.\n;—–]/;

/**
 * Does a condition govern the instruction at `at`?
 *
 * A condition reaches FORWARD, not backward. "If it fails, run X" and "If the
 * scene stalls; run X" are conditional; "Run X; if it fails, run X again" is
 * not — the second clause cannot un-demand the first, which is how a prompt
 * that plainly says "run unity_playthrough" ended up requiring nothing (Codex
 * 2026-09-12 P#4). So: a conditional word anywhere BEFORE the instruction in
 * its sentence governs it, and one AFTER it does only while still inside its
 * own clause ("run X only if needed").
 */
function instructionIsConditional(text: string, at: number): boolean {
  let from = 0;
  for (let i = at; i >= 0; i--) {
    if (text[i] === "." || text[i] === "\n") { from = i + 1; break; }
  }
  return CONDITIONAL_RE.test(text.slice(from, at)) || CONDITIONAL_RE.test(text.slice(at, clauseEnd(text, at)));
}

/** The offset at which the clause containing `from` ends. */
function clauseEnd(text: string, from: number): number {
  const stop = text.slice(from).search(CLAUSE_BREAK);
  return stop === -1 ? text.length : from + stop;
}

/**
 * Every "run <tool>" the prompt writes, with where it sits.
 *
 * ONE matcher for both questions. The tool matcher learned to read a
 * code-formatted name (``Run `unity_playthrough` ``) and the argument matcher
 * did not, so a prompt written the ordinary way named a tool with no
 * requirement on how it is called (Codex 2026-09-12 P#4).
 */
function toolCalls(prompt: string): Array<{ tool: string; at: number; after: number }> {
  const calls: Array<{ tool: string; at: number; after: number }> = [];
  for (const m of prompt.matchAll(/\b(?:run|execute|invoke|call|use|using|via|through)\b(?:\s+(?!unity_)[a-z'-]+){0,4}\s*[`'"*_]*\s*(unity_[a-z0-9_]+)/gi)) {
    calls.push({ tool: m[1]!.toLowerCase(), at: m.index ?? 0, after: (m.index ?? 0) + m[0].length });
  }
  return calls;
}

/**
 * The marker a SYSTEM-WRITTEN prompt uses to state its evidence outright.
 *
 * Every classifier that reads prose is defeated by prose moving: a
 * code-formatted name, a semicolon, a French imperative
 * ("Exécutez unity_playthrough") — each one silently emptied the requirement
 * set (Codex 2026-09-12 P#4). Where the system writes the prompt it does not
 * have to be re-read as English: it says what it demands.
 *
 *   STRADA-REQUIRED-EVIDENCE: unity_playthrough sessions="all"; unity_build_player
 *
 * Declared requirements are added to whatever the prose demands — never
 * subtracted from it — and are not waived by a threshold loop, because they
 * were not inferred in the first place.
 */
export const REQUIRED_EVIDENCE_PREFIX = "STRADA-REQUIRED-EVIDENCE:";

export interface DeclaredEvidence {
  readonly tools: string[];
  readonly args: RequiredToolArgument[];
}

/** What the prompt's own STRADA-REQUIRED-EVIDENCE lines declare. */
export function declaredEvidence(prompt: string): DeclaredEvidence {
  const tools = new Set<string>();
  const args: RequiredToolArgument[] = [];
  const seen = new Set<string>();
  for (const line of prompt.split(/\r?\n/)) {
    const at = line.indexOf(REQUIRED_EVIDENCE_PREFIX);
    if (at < 0) continue;
    for (const entry of line.slice(at + REQUIRED_EVIDENCE_PREFIX.length).split(";")) {
      const text = entry.trim();
      if (text === "") continue;
      const name = /^(unity_[a-z0-9_]+)/i.exec(text);
      if (!name) continue;
      const tool = name[1]!.toLowerCase();
      tools.add(tool);
      for (const a of text.slice(name[0].length).matchAll(/([a-z_]+)\s*[:=]\s*"([^"]{1,60})"/gi)) {
        const key = a[1]!.toLowerCase();
        const value = a[2]!.trim();
        if (value === "") continue;
        const id = `${tool}:${key}:${value.toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        args.push({ tool, key, value });
      }
    }
  }
  return { tools: [...tools], args };
}

export function requiredToolsInPrompt(prompt: string): string[] {
  const out = new Set<string>();
  // "run X", "execute X", "invoke X", "call X", "use X", "using X", "via X",
  // "through X" — with up to a few words between ("run the full suite using
  // unity_test_run"). "run X" alone let "execute unity_x" through (Codex
  // 2026-09-11 B#13).
  // The name may be CODE-FORMATTED or quoted: ``Run `unity_playthrough` `` is
  // the ordinary way to write an instruction, and the gate saw no requirement
  // at all (Codex 2026-09-11 M#2).
  for (const tool of declaredEvidence(prompt).tools) out.add(tool);
  for (const call of toolCalls(prompt)) {
    // A tool named in a CONDITIONAL instruction is required only when that
    // condition holds, and nothing here can judge that — so it is not demanded
    // on the strength of that mention. An UNCONDITIONAL mention elsewhere
    // still demands it: only unconditional mentions ever reach `out` (M#2).
    if (instructionIsConditional(prompt, call.at)) continue;
    out.add(call.tool);
  }
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
  for (const declared of declaredEvidence(prompt).args) {
    const id = `${declared.tool}:${declared.key}:${declared.value.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(declared);
  }
  // The tool, then only what follows it up to the next tool name: "…with
  // target \"android\"" after unity_build_player is not unity_playthrough's
  // argument (Codex 2026-09-11 D#14).
  const calls = toolCalls(prompt);
  for (let c = 0; c < calls.length; c++) {
    const m = calls[c]!;
    const tool = m.tool;
    const from = m.after;
    const to = Math.min(calls[c + 1]?.at ?? prompt.length, from + 160, clauseEnd(prompt, from));
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
    const flagWindow = prompt.slice(Math.max(0, m.at - 120), to);
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

/**
 * The tools named inside a threshold loop's own sentences.
 *
 * The exemption exists because a loop whose threshold already holds correctly
 * does not run its body; it has nothing to say about a tool the prompt demands
 * elsewhere (Codex 2026-09-11 M#2).
 */
export function thresholdLoopTools(prompt: string): Set<string> {
  const tools = new Set<string>();
  if (!THRESHOLD_LOOP_RE.test(prompt)) return tools;
  // The loop's own PROCEDURE is the paragraph it ends: "call A, then call B,
  // … repeat until the count is below N". A paragraph that does not contain
  // the threshold sentence is other work, and its tools are still demanded
  // (Codex 2026-09-11 M#2).
  for (const paragraph of prompt.split(/\n\s*\n/)) {
    if (!THRESHOLD_LOOP_RE.test(paragraph)) continue;
    // The body is described UP TO the "repeat … until" sentence; what follows
    // it is a new instruction. Exempting the whole paragraph waived an
    // unconditional build written after the loop (Codex 2026-09-12 P#4).
    let lastLoopAt = -1;
    for (const m of paragraph.matchAll(new RegExp(THRESHOLD_LOOP_RE.source, "gi"))) lastLoopAt = (m.index ?? 0) + m[0].length;
    const body = paragraph.slice(0, clauseEnd(paragraph, Math.max(0, lastLoopAt)));
    for (const m of body.matchAll(/(unity_[a-z0-9_]+)/gi)) tools.add(m[1]!.toLowerCase());
  }
  return tools;
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
  // …and the exemption covers the tools the LOOP names, not every tool in the
  // prompt: a sprite threshold loop followed by an unconditional Android build
  // waived the build nobody had run (Codex 2026-09-11 M#2).
  const loopTools = thresholdLoopTools(prompt);
  // A DECLARED requirement was not inferred from prose, so no prose loop
  // waives it.
  for (const declared of declaredEvidence(prompt).tools) loopTools.delete(declared);
  const ranSomething = [...loopTools].some((tool) => trace.some((t) => t.toolName === tool && t.success));
  for (const tool of required) {
    const calls = trace.filter((t) => t.toolName === tool);
    if (!calls.some((t) => t.success)) {
      if (loopTools.has(tool) && ranSomething) continue;
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
    if (withArgs.length === 0) {
      // A CALL WITH NO RECORDED ARGUMENTS CANNOT SHOW the task's own argument.
      // Accepting it let `sessions: "all"` pass on a run that never said so
      // (Codex 2026-09-11 M#2).
      shortfalls.push({ tool, attempts: calls.length, argument: { key: wants[0]!.key, value: wants[0]!.value } });
      continue;
    }
    // TWO VALUES FOR ONE KEY ARE TWO CALLS. Requiring a single call to satisfy
    // every named argument made an ordinary instruction unsatisfiable:
    // "Run unity_build_player with target \"Android\". Run unity_build_player
    // with target \"iOS\"." demanded one call whose target was both at once,
    // and an honest two-call run failed the gate (Codex 2026-09-12 P#3).
    // Different KEYS must still co-occur in one call — that is the
    // combination-nobody-made defect (D#10).
    const byKey = new Map<string, Set<string>>();
    for (const w of wants) {
      const key = w.key.toLowerCase();
      const values = byKey.get(key) ?? new Set<string>();
      values.add(w.value);
      byKey.set(key, values);
    }
    const singleValued = [...byKey.entries()].filter(([, v]) => v.size === 1).map(([k, v]) => ({ key: k, value: [...v][0]! }));
    const multiValued = [...byKey.entries()].filter(([, v]) => v.size > 1);
    const together = singleValued.length === 0
      || withArgs.some((t) => singleValued.every((w) => argSatisfies(t.args!, w.key, w.value)));
    const eachValueSeen = multiValued.every(([key, values]) =>
      [...values].every((value) => withArgs.some((t) => argSatisfies(t.args!, key, value))));
    if (together && eachValueSeen) continue;
    const unmetSingle = singleValued.find((w) => !withArgs.some((t) => argSatisfies(t.args!, w.key, w.value)));
    const unmetMulti = multiValued
      .flatMap(([key, values]) => [...values].map((value) => ({ key, value })))
      .find((w) => !withArgs.some((t) => argSatisfies(t.args!, w.key, w.value)));
    const firstUnmet = unmetSingle ?? unmetMulti ?? { key: singleValued[0]?.key ?? wants[0]!.key, value: singleValued[0]?.value ?? wants[0]!.value };
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

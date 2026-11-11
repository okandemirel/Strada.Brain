/**
 * Which phases may run a write, which of a model turn's calls run, what a refused one is told,
 * and the turn-context sentence that says so before the model calls one.
 *
 * The worker's tool list is the run's list, the same bytes on every call. Write tools used to be
 * taken out of it while the agent was planning, replanning or reflecting, so the list changed on
 * 35–46% of consecutive calls in the replayed daemon logs (2026-08 to 2026-10,
 * scripts/eval/compaction-replay.mjs). The tool schemas come before the history in a request,
 * so each change made the provider's prefix cache miss the whole history, the reflection calls'
 * included (docs/memory/entries/2026-11-06-system-prompt-is-byte-stable.md).
 *
 * So the phase rule is not a property of the list. It is decided once per model turn, on the
 * calls, before anything reads them ({@link splitCallsByPhase}); the orchestrator's tool-call
 * gate refuses a write in such a phase from any other caller (through {@link phaseAllowsWrites});
 * and the turn context of every call made in a phase that does not write says so
 * ({@link buildPhaseWriteNotice}). The turn context rides after the history and is never cached,
 * so the sentence costs only itself.
 */

import { AgentPhase } from "../../agents/agent-state.js";
import type { ToolCall, ToolResult } from "../../agents/providers/provider-core.interface.js";

/** The phases in which a write may run. Planning, replanning and reflecting do not write. */
export const PHASES_ALLOWING_WRITES: ReadonlySet<AgentPhase> = new Set([
  AgentPhase.EXECUTING,
  AgentPhase.COMPLETE,
  AgentPhase.FAILED,
]);

export function phaseAllowsWrites(phase: AgentPhase): boolean {
  return PHASES_ALLOWING_WRITES.has(phase);
}

/** The text a write called in `phase` gets in place of running. */
export function phaseWriteRefusal(phase: AgentPhase): string {
  return (
    `Write operations are not available while the agent is ${phase}. ` +
    `Finish planning or reflecting first; writes run in the executing phase.`
  );
}

/** The metadata key that marks a result as this refusal; its value is the phase. */
const REFUSED_IN_PHASE = "refusedInPhase";

/**
 * The tool result a write called in `phase` gets in place of running: an error the model reads,
 * and a mark that says the tool never ran ({@link isPhaseWriteRefusal}).
 */
export function phaseWriteRefusalResult(toolCallId: string, phase: AgentPhase): ToolResult {
  return { toolCallId, content: phaseWriteRefusal(phase), isError: true, metadata: { [REFUSED_IN_PHASE]: phase } };
}

/** Whether `result` is the refusal of a write in a phase that does not write. */
export function isPhaseWriteRefusal(result: Pick<ToolResult, "isError" | "metadata"> | undefined): boolean {
  return result?.isError === true && typeof result.metadata?.[REFUSED_IN_PHASE] === "string";
}

/** The phase rule as one predicate: whether a call of `toolName` made in `phase` is refused. */
export type PhaseRefuses = (toolName: string, phase: AgentPhase) => boolean;

/**
 * A model turn's tool calls, split once by the phase they were made in.
 *
 * The rule used to be decided per call at the gate, and each reader of the turn's calls or
 * results was then taught not to count a refused write. QA found an untaught reader three times
 * on 2026-11-11: the step records (the verifier, the reflection cadence, the DONE check), the
 * run's executed-tool sequence (the supervisor's node verifier), and the plan-review gate, whose
 * count was taken from the call list before any result existed. So the decision is made here,
 * once, on the calls, as soon as the model's turn arrives, and the readers are handed only the
 * calls that run: whatever counts calls, records steps, writes the tool sequence, emits tool
 * events, marks a tracker or opens a gate takes `runnable`. A refused call stays in the assistant
 * turn the model made (`asMade`) and is answered there with its refusal (`refusals`); nothing else
 * reads either. `phase-write-access.test.ts` names every place allowed to read them.
 */
export interface PhaseCallSplit {
  /** Every call of the turn, in the model's order: its tool_use blocks, each answered in the session. */
  readonly asMade: readonly ToolCall[];
  /** The calls that run, in the model's order. */
  readonly runnable: readonly ToolCall[];
  /** The answer each refused call gets in place of running, by call id. */
  readonly refusals: ReadonlyMap<string, ToolResult>;
}

/** Splits a model turn's calls by the phase they were made in: the one place the rule is decided. */
export function splitCallsByPhase(
  calls: readonly ToolCall[],
  phase: AgentPhase,
  refuses: PhaseRefuses,
): PhaseCallSplit {
  const runnable: ToolCall[] = [];
  const refusals = new Map<string, ToolResult>();
  for (const call of calls) {
    if (refuses(call.name, phase)) refusals.set(call.id, phaseWriteRefusalResult(call.id, phase));
    else runnable.push(call);
  }
  return { asMade: calls, runnable, refusals };
}

/** A split in which every call runs: what a turn whose caller decided nothing gets. */
export function allCallsRun(calls: readonly ToolCall[]): PhaseCallSplit {
  return { asMade: calls, runnable: calls, refusals: new Map() };
}

/**
 * The names of `toolNames` that a call made now, in `phase`, would run.
 *
 * The offered list is the run's list in every phase, so it answers "which tools does the run
 * have", not "which can run now". A reader that runs a tool itself, in the phase of the state it
 * hands the gate, asks the second question: the loop recovery's delegation, which picked a
 * delegate tool while reflecting and had the gate's refusal recorded as its diagnosis (QA,
 * 2026-11-11).
 */
export function toolNamesRunnableIn(
  toolNames: readonly string[],
  phase: AgentPhase,
  refuses: PhaseRefuses,
): string[] {
  return toolNames.filter((name) => !refuses(name, phase));
}

/**
 * The turn-context section for a phase that does not write; undefined in one that does.
 *
 * It names the refusal a write gets, because the tool list no longer shows the phase: every
 * write tool is listed in every phase. A reflecting turn's tool calls are not run at all (the
 * runner reads its decision and nothing else), so that phase says so too.
 */
export function buildPhaseWriteNotice(phase: AgentPhase): string | undefined {
  if (phaseAllowsWrites(phase)) return undefined;
  const lines = [
    "## Writes in this phase",
    `The agent is ${phase}. Your tool list is the same in every phase, but a write tool called now ` +
      "does not run: it is answered with a refusal, and writes run in the executing phase.",
  ];
  if (phase === AgentPhase.REFLECTING) {
    lines.push("This is a reflection turn: answer with your decision. A tool call made in it is not run.");
  } else {
    lines.push("Read what you need with read-only tools, then answer with the plan.");
  }
  return lines.join("\n");
}

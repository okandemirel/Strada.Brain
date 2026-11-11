/**
 * Which phases may run a write, what a write called in another phase is told, and the
 * turn-context sentence that says so before the model calls one.
 *
 * The worker's tool list is the run's list, the same bytes on every call. Write tools used to be
 * taken out of it while the agent was planning, replanning or reflecting, so the list changed on
 * 35–46% of consecutive calls in the replayed daemon logs (2026-08 to 2026-10,
 * scripts/eval/compaction-replay.mjs). The tool schemas come before the history in a request,
 * so each change made the provider's prefix cache miss the whole history, the reflection calls'
 * included (docs/memory/entries/2026-11-06-system-prompt-is-byte-stable.md).
 *
 * So the phase rule is not a property of the list. It is enforced where a call runs (the
 * orchestrator's tool-call gate, through {@link phaseAllowsWrites}), and stated in the turn
 * context of every call made in a phase that does not write ({@link buildPhaseWriteNotice}).
 * The turn context rides after the history and is never cached, so the sentence costs only itself.
 */

import { AgentPhase } from "../../agents/agent-state.js";
import type { ToolResult } from "../../agents/providers/provider-core.interface.js";

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
 * The tool result the gate returns for a write called in `phase`: an error the model reads, and
 * a mark that says the tool never ran.
 *
 * The mark is what the run's records read ({@link isPhaseWriteRefusal}). Recorded as a failed
 * write, the refusal was an open failing path the verifier asked to re-run in a project with
 * nothing to verify with, three of them forced a reflection after every later batch, and one
 * turned the model's DONE into CONTINUE (QA, 2026-11-11). Nothing ran, so nothing is recorded:
 * the refusal is the model's answer, not a step the run took.
 */
export function phaseWriteRefusalResult(toolCallId: string, phase: AgentPhase): ToolResult {
  return { toolCallId, content: phaseWriteRefusal(phase), isError: true, metadata: { [REFUSED_IN_PHASE]: phase } };
}

/** Whether `result` is the gate's refusal of a write in a phase that does not write. */
export function isPhaseWriteRefusal(result: Pick<ToolResult, "isError" | "metadata"> | undefined): boolean {
  return result?.isError === true && typeof result.metadata?.[REFUSED_IN_PHASE] === "string";
}

/**
 * The turn-context section for a phase that does not write; undefined in one that does.
 *
 * It names the refusal the gate gives, because the tool list no longer shows the phase: every
 * write tool is listed in every phase. A reflecting turn's tool calls are not run at all (the
 * runner reads its decision and nothing else), so that phase says so too.
 */
export function buildPhaseWriteNotice(phase: AgentPhase): string | undefined {
  if (phaseAllowsWrites(phase)) return undefined;
  const lines = [
    "## Writes in this phase",
    `The agent is ${phase}. Your tool list is the same in every phase, but a write tool called now ` +
      "is refused and changes nothing: writes run in the executing phase.",
  ];
  if (phase === AgentPhase.REFLECTING) {
    lines.push("This is a reflection turn: answer with your decision. A tool call made in it is not run.");
  } else {
    lines.push("Read what you need with read-only tools, then answer with the plan.");
  }
  return lines.join("\n");
}

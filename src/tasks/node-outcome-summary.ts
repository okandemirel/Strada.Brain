import type { NodeResult } from "../supervisor/supervisor-types.js";

/** Keeps one runaway node output from burying the four lines beside it. */
const MAX_REASON = 220;

function reasonFor(node: NodeResult): string {
  if (node.blockedReason && node.blockedReason.trim() !== "") {
    return node.blockedReason.trim();
  }
  // The last non-empty line is where a failure usually says what it was: an
  // assertion, a compiler error, the sentence the agent stopped on.
  const lines = node.output.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 ? lines[lines.length - 1]!.trim() : "no output";
}

/**
 * One line per node that did not succeed: which node, what happened, on which
 * provider, and why.
 *
 * Measured 2026-08-21, run 37: a supervised run ended "nodes: 5, succeeded: 1,
 * failed: 4" after sixty-five minutes, and the log held not one line about any
 * individual node, nor a single error-level entry. Everything needed was in
 * nodeResults and none of it was written down, so the decision that ended the
 * run could not be examined at all.
 *
 * Successful nodes are omitted on purpose — the tally already counts them, and
 * a failure is easier to find in four lines than in forty.
 */
export function summariseNodeOutcomes(nodeResults: readonly NodeResult[]): string[] {
  const out: string[] = [];
  for (const node of nodeResults) {
    if (node.status === "ok") continue;
    const reason = reasonFor(node).slice(0, MAX_REASON);
    // The aggregator files a node carrying a blockedReason under "blocked" and
    // then folds it into the failed count, so a settled run reported four
    // failures whether they were compiler errors or an agent waiting on a
    // decision. Those call for opposite responses; name which one this is.
    const state = node.blockedReason && node.blockedReason.trim() !== "" ? "blocked" : node.status;
    out.push(`${node.nodeId} ${state} on ${node.provider}: ${reason}`);
  }
  return out;
}

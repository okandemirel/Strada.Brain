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
 * Measured in a live campaign: a supervised run ended with only a tally
 * (nodes, succeeded, failed) after more than an hour, and the log held no line
 * about any individual node and no error-level entry. Everything needed was in
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
    // then folds it into the failed count, so a settled run reported every one
    // of them as a failure whether they were compiler errors or an agent
    // waiting on a decision. Those call for opposite responses; name which one this is.
    const state = node.blockedReason && node.blockedReason.trim() !== "" ? "blocked" : node.status;
    out.push(`${node.nodeId} ${state} on ${node.provider}: ${reason}`);
  }
  return out;
}

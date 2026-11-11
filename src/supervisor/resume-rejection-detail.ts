import type { NodeResult } from "./supervisor-types.js";

/**
 * The per-step lines of a failed resume re-verification. A step is named by
 * its task text, never by its internal goal id: the user reads this message.
 */
export function resumeRejectionDetail(
  verified: readonly NodeResult[],
  nodes: Iterable<{ readonly id: string; readonly task: string }>,
): string {
  const taskOf = new Map<string, string>();
  for (const n of nodes) taskOf.set(String(n.id), n.task);
  return verified
    .filter((r) => r.status !== "ok" || (r.output ?? "").length > 0)
    .map((r) => {
      const task = (taskOf.get(String(r.nodeId)) ?? "").trim().replace(/\s+/g, " ");
      const name = task.length > 120 ? `${task.slice(0, 119)}…` : task || "a saved step";
      return `- ${name}: ${(r.output ?? "").slice(0, 200) || r.status}`;
    })
    .slice(0, 8)
    .join("\n");
}

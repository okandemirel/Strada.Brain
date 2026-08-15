/**
 * A batch of tool calls is still a batch of tool calls.
 *
 * Every gate the product has — the read-only block, the self-managed write
 * review, the destructive-operation refusal, the user confirmation — lives on
 * one dispatch path: `Orchestrator.executeSingleToolCall`. `batch_execute`
 * reaches a tool by another route: it takes an array of operations and calls
 * `tool.execute(op.input, context)` on each one directly.
 *
 * Measured over five days of real runs: 177 `batch_execute` calls carrying 1,345
 * inner operations, among them 261 `file_write`, 31 `file_delete`, 29
 * `file_rename`, 24 `file_edit` and 21 `shell_exec`. More writes went through
 * the ungated batch path (261) than through the gated direct one (197). The one
 * gate that could have caught them switches on tool name and lets
 * `batch_execute` fall to `default: return { approved: true }` — an
 * unconditional stamp that never looks at the operations array.
 *
 * This module reads that array so the caller can review each operation with the
 * same rules it applies to a direct call.
 */

/** One entry of a batch tool's `operations` array. */
export interface BatchOperation {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Tools that dispatch a nested list of operations.
 *
 * A tool named here MUST have its operations reviewed individually; being on
 * this list is what marks it as a second dispatch path.
 */
export const BATCH_DISPATCH_TOOLS: ReadonlySet<string> = new Set(["batch_execute"]);

export type BatchParse =
  | { kind: "ok"; operations: BatchOperation[] }
  | { kind: "unreviewable"; reason: string };

/**
 * Read a batch tool's operations, or say why they cannot be reviewed.
 *
 * Anything this cannot read is `unreviewable` rather than empty: a batch whose
 * shape we do not understand must not be waved through on the grounds that we
 * found no writes in it.
 */
export function parseBatchOperations(input: Record<string, unknown>): BatchParse {
  const raw = input["operations"];
  if (!Array.isArray(raw)) {
    return { kind: "unreviewable", reason: "operations is missing or not an array" };
  }
  if (raw.length === 0) {
    return { kind: "unreviewable", reason: "operations is empty" };
  }

  const operations: BatchOperation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { kind: "unreviewable", reason: `operation ${i} is not an object` };
    }
    const record = entry as Record<string, unknown>;
    const tool = record["tool"];
    if (typeof tool !== "string" || tool.trim() === "") {
      return { kind: "unreviewable", reason: `operation ${i} has no tool name` };
    }
    // A batch inside a batch would make the review recursive and its depth
    // attacker-controlled. The batch tool itself already refuses to nest; this
    // refuses to *approve* a nested one, which is the half that matters here.
    if (BATCH_DISPATCH_TOOLS.has(tool)) {
      return { kind: "unreviewable", reason: `operation ${i} nests ${tool}` };
    }
    const opInput = record["input"];
    if (typeof opInput !== "object" || opInput === null || Array.isArray(opInput)) {
      return { kind: "unreviewable", reason: `operation ${i} (${tool}) has no input object` };
    }
    operations.push({ tool: tool.trim(), input: opInput as Record<string, unknown> });
  }

  return { kind: "ok", operations };
}

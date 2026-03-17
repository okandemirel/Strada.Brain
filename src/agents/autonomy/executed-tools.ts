import type { ToolResult } from "../providers/provider.interface.js";

interface BatchOperationInput {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export interface ExecutedToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly isError: boolean;
  readonly output: string;
}

function toOutputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBatchOperations(input: Record<string, unknown>): BatchOperationInput[] {
  const operations = input["operations"];
  if (!Array.isArray(operations)) {
    return [];
  }

  return operations.flatMap((operation): BatchOperationInput[] => {
    if (!isRecord(operation) || typeof operation["tool"] !== "string") {
      return [];
    }
    return [{
      toolName: operation["tool"],
      input: isRecord(operation["input"]) ? operation["input"] : {},
    }];
  });
}

function parseBatchResults(content: unknown): Array<{ success: boolean; output: string }> | null {
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(content);
    if (!isRecord(parsed) || !Array.isArray(parsed["results"])) {
      return null;
    }

    return parsed["results"].flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const success = entry["success"] === true;
      const output =
        typeof entry["content"] === "string"
          ? entry["content"]
          : typeof entry["error"] === "string"
            ? entry["error"]
            : "";
      return [{ success, output }];
    });
  } catch {
    return null;
  }
}

export function expandExecutedToolCalls(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ExecutedToolCall[] {
  if (toolName !== "batch_execute") {
    return [{
      toolName,
      input,
      isError: result.isError ?? false,
      output: toOutputText(result.content),
    }];
  }

  const operations = parseBatchOperations(input);
  const results = parseBatchResults(result.content);
  if (operations.length === 0 || !results || results.length === 0) {
    return [{
      toolName,
      input,
      isError: result.isError ?? false,
      output: toOutputText(result.content),
    }];
  }

  return operations.slice(0, results.length).map((operation, index) => {
    const operationResult = results[index]!;
    return {
      toolName: operation.toolName,
      input: operation.input,
      isError: !operationResult.success,
      output: operationResult.output,
    };
  });
}

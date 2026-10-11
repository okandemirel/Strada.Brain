/**
 * A file read inside batch_execute is still a file read.
 *
 * file_read and grep_search results reach the model as the file holds them
 * (audit orchestrator#1), but the carve-out keyed on the OUTER tool name, so
 * the same reads inside batch_execute — 177 batches carrying 1,345 operations
 * in five measured days — still went through the injection rewriter: NFKC,
 * "[base64:Nch]", "[filtered:override]". A batch with one failed operation
 * was rewritten a second time on the error-recovery path, so even a fixed
 * first pass did not survive a missing file next to a good one.
 *
 * The batch tool here returns what Strada.MCP's batch_execute returns: a JSON
 * document with one entry per operation, isError when any of them failed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { trackAndRecordToolResults } from "./orchestrator-tool-execution.js";
import { ErrorRecoveryEngine } from "./autonomy/error-recovery.js";
import { FileReadTool } from "./tools/file-read.js";
import type { ToolResult } from "./providers/provider-core.interface.js";
import { createMockChannel, createMockProvider } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const ICON =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAA==";
const OVERRIDE_LINE = "    protected override void OnUpdate() { } // ticks the movement system";
const CRLF_SOURCE = [
  "using UnityEngine;",
  "public class A {",
  '    string s = "（はい）！";',
  `    const string Icon = "${ICON}";`,
  OVERRIDE_LINE,
  '    string id = "token-refresh-interval-seconds";',
  "}",
  "",
].join("\r\n");

type Executable = { execute(input: Record<string, unknown>, ctx: unknown): Promise<{ content: string; isError?: boolean }> };

/** Strada.MCP's batch_execute, reduced to its dispatch and its output shape. */
function batchExecute(tools: Record<string, Executable>) {
  return {
    name: "batch_execute",
    description: "Execute multiple tool operations in a single call.",
    inputSchema: { type: "object" as const, properties: { operations: { type: "array" } }, required: ["operations"] },
    async execute(input: Record<string, unknown>, ctx: unknown) {
      const results = [];
      for (const op of input["operations"] as Array<{ tool: string; input: Record<string, unknown> }>) {
        const result = await tools[op.tool]!.execute(op.input, ctx);
        results.push({
          tool: op.tool,
          success: !result.isError,
          content: result.content,
          error: result.isError ? result.content : undefined,
          durationMs: 0,
        });
      }
      const failureCount = results.filter((r) => !r.success).length;
      return {
        content: JSON.stringify(
          { results, totalDurationMs: 0, stopped: false, successCount: results.length - failureCount, failureCount },
          null,
          2,
        ),
        ...(failureCount > 0 ? { isError: true } : {}),
      };
    },
  };
}

let projectPath: string;
let orch: Orchestrator;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "batch-file-content-fidelity-"));
  writeFileSync(join(projectPath, "A.cs"), CRLF_SOURCE);
  const fileRead = new FileReadTool();
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [fileRead, batchExecute({ file_read: fileRead })] as never,
    channel: createMockChannel() as never,
    projectPath,
    readOnly: false,
    requireConfirmation: false,
  });
});

afterEach(() => {
  orch.dispose();
  rmSync(projectPath, { recursive: true, force: true });
});

async function runBatch(paths: string[]): Promise<ToolResult> {
  const call = {
    id: "tc-batch",
    name: "batch_execute",
    input: { operations: paths.map((path) => ({ tool: "file_read", input: { path } })), stopOnError: false },
  };
  const results = await (
    orch as unknown as { executeToolCalls: (c: string, t: unknown[], o: unknown) => Promise<ToolResult[]> }
  ).executeToolCalls("chat-batch", [call], { mode: "background" });
  // What the agent loop does next: error recovery may append guidance.
  trackAndRecordToolResults({
    chatId: "chat-batch",
    toolCalls: [call],
    toolResults: results,
    taskPlanner: { trackToolCall: vi.fn(), recordError: vi.fn() },
    selfVerification: { track: vi.fn(), ingestWorkerResult: vi.fn() },
    stradaConformance: { trackToolCall: vi.fn() },
    errorRecovery: new ErrorRecoveryEngine(),
    executionJournal: { recordToolBatch: vi.fn() } as never,
    agentPhase: "executing" as never,
    providerName: "mock",
    emitToolResult: vi.fn(),
  });
  return results[0]!;
}

/** The batch document at the head of the result, without any guidance appended after it. */
function batchDocument(content: string): { results: Array<{ tool: string; success: boolean; content: string }> } {
  const end = content.lastIndexOf("\n}") + 2;
  return JSON.parse(content.slice(0, end)) as { results: Array<{ tool: string; success: boolean; content: string }> };
}

/** The source lines as the model reads them back out of a numbered file_read result. */
function shownLines(readResult: string): string[] {
  return readResult
    .split("\n")
    .filter((line) => /^\s*\d+ \| /.test(line))
    .map((line) => line.replace(/^\s*\d+ \| /, ""));
}

describe("file_read inside batch_execute", () => {
  it("shows the file as it is on disk", async () => {
    const result = await runBatch(["A.cs"]);

    expect(result.isError).toBeFalsy();
    const [read] = batchDocument(result.content).results;
    expect(read!.success).toBe(true);
    expect(shownLines(read!.content)).toEqual(CRLF_SOURCE.split("\n"));
  });

  it("still shows it when another operation in the batch failed", async () => {
    const result = await runBatch(["Missing.cs", "A.cs"]);

    expect(result.isError).toBe(true);
    // The guidance error recovery adds is there...
    expect(result.content).toContain("[ERROR RECOVERY");
    // ...and the read beside the failure is still the file.
    const [missing, read] = batchDocument(result.content).results;
    expect(missing!.success).toBe(false);
    expect(shownLines(read!.content)).toEqual(CRLF_SOURCE.split("\n"));
  });
});

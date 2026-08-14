/**
 * A tool invented at runtime can still change the project.
 *
 * Write classification was a fixed allowlist, and a tool registered during a run
 * cannot be in a list written before it existed. Every dynamic tool therefore
 * read as non-write and skipped read-only mode, the plan-review gate and write
 * confirmation alike.
 *
 * Measured: an agent registered `dynamic_write_minified_file` — a shell-backed
 * file writer — and the policy answered "non-write operations execute without
 * interactive confirmation". It wrote five .asmdef files through a shell, which
 * ate the JSON quoting, and reported success on all five. The run ended with
 * four assembly definitions Unity cannot parse.
 */

import { describe, it, expect } from "vitest";
import { vi, beforeAll } from "vitest";
import { looksLikeWriteTool } from "./autonomy/constants.js";
import { createLogger } from "../utils/logger.js";
import { Orchestrator } from "./orchestrator.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function makeOrchestrator(): Orchestrator {
  const provider = {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
    healthCheck: vi.fn(),
  };
  return new Orchestrator({
    providerManager: {
      getProvider: () => provider,
      getProviderByName: () => provider,
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      listAvailable: () => [{ name: "mock", label: "mock", defaultModel: "default" }],
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { sendMessage: vi.fn(), type: "cli" } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: true,
  });
}

/** The orchestrator's own verdict for a tool name. */
function classifies(orchestrator: Orchestrator, name: string): boolean {
  return (
    orchestrator as unknown as { isWriteOperation(n: string): boolean }
  ).isWriteOperation(name);
}

describe("classifying a tool the allowlist does not know", () => {
  it("treats the measured offender as a write", () => {
    expect(looksLikeWriteTool("dynamic_write_minified_file")).toBe(true);
  });

  it("catches mutation verbs wherever they sit in the name", () => {
    for (const name of [
      "dynamic_file_write",
      "write_config",
      "create_module",
      "delete_stale_assets",
      "apply_patch",
      "run_shell_snippet",
    ]) {
      expect(looksLikeWriteTool(name), `${name} read as read-only`).toBe(true);
    }
  });

  it("catches a writer whose name gives nothing away", () => {
    // The shape of every file writer: somewhere to put it, something to put.
    const tool = {
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    };
    expect(looksLikeWriteTool("persist_asset", tool)).toBe(true);
  });

  it("leaves genuine read-only tools alone", () => {
    // A confirmation on every lookup would train the user to click through them.
    const reader = {
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    };
    expect(looksLikeWriteTool("dynamic_read_file", reader)).toBe(false);
    expect(looksLikeWriteTool("lookup_symbol")).toBe(false);
    expect(looksLikeWriteTool("summarize_findings")).toBe(false);
  });

  it("does not call a payload alone a write", () => {
    // No target: nothing is being written anywhere.
    const analyser = {
      inputSchema: { type: "object", properties: { content: { type: "string" } } },
    };
    expect(looksLikeWriteTool("classify_text", analyser)).toBe(false);
  });

  it("copes with a tool that declares no schema", () => {
    expect(() => looksLikeWriteTool("mystery_tool")).not.toThrow();
    expect(looksLikeWriteTool("mystery_tool")).toBe(false);
  });

});

describe("the orchestrator applies the classification", () => {
  it("calls a runtime-registered writer a write operation", () => {
    // Without this the classifier is dead code: the policy asks the
    // orchestrator, not the helper. Asserting on looksLikeWriteTool alone would
    // pass with the orchestrator still consulting only the allowlist.
    const orchestrator = makeOrchestrator();
    orchestrator.addTool({
      name: "dynamic_write_minified_file",
      description: "writes a minified file",
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
      execute: async () => ({ content: "ok", isError: false }),
    } as never);

    expect(classifies(orchestrator, "dynamic_write_minified_file")).toBe(true);
  });

  it("believes a tool that declares itself read-only", () => {
    // An explicit declaration outranks the name heuristic, so a tool whose name
    // merely mentions a verb is not punished for it.
    const orchestrator = makeOrchestrator();
    orchestrator.addTool(
      {
        name: "write_preview_renderer",
        description: "renders a preview of a pending write",
        inputSchema: { type: "object" as const, properties: {} },
        execute: async () => ({ content: "ok", isError: false }),
      } as never,
      { readOnly: true } as never,
    );

    expect(classifies(orchestrator, "write_preview_renderer")).toBe(false);
  });

  it("still knows the built-in write tools", () => {
    const orchestrator = makeOrchestrator();
    expect(classifies(orchestrator, "file_write")).toBe(true);
  });
});

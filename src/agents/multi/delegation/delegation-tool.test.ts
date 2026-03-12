/**
 * Tests for DelegationTool
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelegationTool, createDelegationTools } from "./delegation-tool.js";
import type { DelegationTypeConfig, DelegationResult, DelegationRequest } from "./delegation-types.js";
import type { ToolContext } from "../../tools/tool-core.interface.js";
import type { AgentId } from "../agent-types.js";

// =============================================================================
// MOCK DELEGATION MANAGER
// =============================================================================

function createMockDelegationManager() {
  return {
    delegate: vi.fn<(req: DelegationRequest) => Promise<DelegationResult>>(),
    delegateAsync: vi.fn<(req: DelegationRequest) => Promise<void>>(),
  };
}

type MockDelegationManager = ReturnType<typeof createMockDelegationManager>;

// =============================================================================
// TEST FIXTURES
// =============================================================================

const TEST_TYPE_CONFIG: DelegationTypeConfig = {
  name: "code_review",
  tier: "cheap",
  timeoutMs: 60000,
  maxIterations: 10,
};

const TEST_TYPE_CONFIG_WITH_PROMPT: DelegationTypeConfig = {
  name: "analysis",
  tier: "standard",
  timeoutMs: 90000,
  maxIterations: 15,
  systemPrompt: "You are an expert code analyst.",
};

const TEST_PARENT_AGENT_ID = "parent-agent-001" as AgentId;
const TEST_DEPTH = 0;

const TEST_TOOL_CONTEXT: ToolContext = {
  projectPath: "/test/project",
  workingDirectory: "/test/project",
  readOnly: false,
  userId: "user-1",
  chatId: "chat-1",
  sessionId: "session-1",
};

const TEST_DELEGATION_RESULT: DelegationResult = {
  content: "Code review completed. Found 3 issues.",
  metadata: {
    model: "deepseek-chat",
    tier: "cheap",
    costUsd: 0.002,
    durationMs: 5000,
    toolsUsed: ["read_file", "search_code"],
    escalated: false,
  },
};

// =============================================================================
// TESTS
// =============================================================================

describe("DelegationTool", () => {
  let mockManager: MockDelegationManager;
  let tool: DelegationTool;

  beforeEach(() => {
    mockManager = createMockDelegationManager();
    tool = new DelegationTool(
      TEST_TYPE_CONFIG,
      mockManager as never,
      TEST_PARENT_AGENT_ID,
      TEST_DEPTH,
    );
  });

  describe("name and description", () => {
    it("name is delegate_{typeName}", () => {
      expect(tool.name).toBe("delegate_code_review");
    });

    it("description is auto-generated from type name when no custom systemPrompt", () => {
      expect(tool.description).toContain("code review");
    });

    it("description uses systemPrompt when provided", () => {
      const toolWithPrompt = new DelegationTool(
        TEST_TYPE_CONFIG_WITH_PROMPT,
        mockManager as never,
        TEST_PARENT_AGENT_ID,
        TEST_DEPTH,
      );
      expect(toolWithPrompt.description).toBe("You are an expert code analyst.");
    });
  });

  describe("inputSchema", () => {
    it("has required task field of type string", () => {
      const schema = tool.inputSchema;
      expect(schema).toHaveProperty("type", "object");
      expect(schema).toHaveProperty("properties.task.type", "string");
      expect(schema).toHaveProperty("required");
      expect((schema as { required: string[] }).required).toContain("task");
    });

    it("has optional context field of type string", () => {
      const schema = tool.inputSchema;
      expect(schema).toHaveProperty("properties.context.type", "string");
    });

    it("has optional mode field with sync/async enum", () => {
      const schema = tool.inputSchema;
      expect(schema).toHaveProperty("properties.mode.type", "string");
      expect(schema).toHaveProperty("properties.mode.enum");
      const modeEnum = (schema as { properties: { mode: { enum: string[] } } }).properties.mode.enum;
      expect(modeEnum).toEqual(["sync", "async"]);
    });
  });

  describe("metadata", () => {
    it("has category delegation and riskLevel medium", () => {
      expect(tool.metadata).toBeDefined();
      expect(tool.metadata!.category).toBe("delegation");
      expect(tool.metadata!.riskLevel).toBe("medium");
    });
  });

  describe("execute() sync mode", () => {
    it("calls delegationManager.delegate() with correct DelegationRequest", async () => {
      mockManager.delegate.mockResolvedValue(TEST_DELEGATION_RESULT);

      await tool.execute(
        { task: "Review this code", context: "src/main.ts" },
        TEST_TOOL_CONTEXT,
      );

      expect(mockManager.delegate).toHaveBeenCalledOnce();
      const req = mockManager.delegate.mock.calls[0]![0];
      expect(req.type).toBe("code_review");
      expect(req.task).toBe("Review this code");
      expect(req.context).toBe("src/main.ts");
      expect(req.parentAgentId).toBe(TEST_PARENT_AGENT_ID);
      expect(req.depth).toBe(TEST_DEPTH);
      expect(req.mode).toBe("sync");
      expect(req.toolContext).toEqual(TEST_TOOL_CONTEXT);
    });

    it("returns ToolExecutionResult with delegation result content and metadata", async () => {
      mockManager.delegate.mockResolvedValue(TEST_DELEGATION_RESULT);

      const result = await tool.execute(
        { task: "Review this code" },
        TEST_TOOL_CONTEXT,
      );

      expect(result.content).toBe("Code review completed. Found 3 issues.");
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.delegationType).toBe("code_review");
      expect(result.metadata!.delegationMode).toBe("sync");
      expect(result.metadata!.model).toBe("deepseek-chat");
      expect(result.metadata!.tier).toBe("cheap");
    });

    it("defaults to sync mode when mode not specified", async () => {
      mockManager.delegate.mockResolvedValue(TEST_DELEGATION_RESULT);

      await tool.execute({ task: "Review this code" }, TEST_TOOL_CONTEXT);

      const req = mockManager.delegate.mock.calls[0]![0];
      expect(req.mode).toBe("sync");
    });
  });

  describe("execute() async mode", () => {
    it("calls delegateAsync() and returns immediate acknowledgment", async () => {
      mockManager.delegateAsync.mockResolvedValue(undefined);

      const result = await tool.execute(
        { task: "Analyze this file", mode: "async" },
        TEST_TOOL_CONTEXT,
      );

      expect(mockManager.delegateAsync).toHaveBeenCalledOnce();
      expect(mockManager.delegate).not.toHaveBeenCalled();
      expect(result.content).toContain("code_review");
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.delegationMode).toBe("async");
    });
  });

  describe("execute() error handling", () => {
    it("returns isError: true with failure message on error", async () => {
      mockManager.delegate.mockRejectedValue(new Error("Budget exceeded"));

      const result = await tool.execute(
        { task: "Review this code" },
        TEST_TOOL_CONTEXT,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Sub-agent failed");
      expect(result.content).toContain("Budget exceeded");
    });
  });
});

describe("createDelegationTools", () => {
  let mockManager: MockDelegationManager;

  const TEST_TYPES: DelegationTypeConfig[] = [
    { name: "code_review", tier: "cheap", timeoutMs: 60000, maxIterations: 10 },
    { name: "analysis", tier: "standard", timeoutMs: 90000, maxIterations: 15 },
  ];

  beforeEach(() => {
    mockManager = createMockDelegationManager();
  });

  it("returns array of DelegationTool instances from config types", () => {
    const tools = createDelegationTools(
      TEST_TYPES,
      mockManager as never,
      TEST_PARENT_AGENT_ID,
      0,
      2,
    );

    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("delegate_code_review");
    expect(tools[1]!.name).toBe("delegate_analysis");
  });

  it("at max depth returns empty array", () => {
    const tools = createDelegationTools(
      TEST_TYPES,
      mockManager as never,
      TEST_PARENT_AGENT_ID,
      2, // currentDepth = maxDepth
      2, // maxDepth
    );

    expect(tools).toHaveLength(0);
  });

  it("at depth < maxDepth returns tools with incremented depth", async () => {
    mockManager.delegate.mockResolvedValue(TEST_DELEGATION_RESULT);

    const tools = createDelegationTools(
      TEST_TYPES,
      mockManager as never,
      TEST_PARENT_AGENT_ID,
      0, // currentDepth
      2, // maxDepth
    );

    expect(tools).toHaveLength(2);

    // Execute a tool and verify the depth in the request is currentDepth + 1 = 1
    await tools[0]!.execute({ task: "test" }, TEST_TOOL_CONTEXT);
    const req = mockManager.delegate.mock.calls[0]![0];
    expect(req.depth).toBe(1);
  });

  it("at depth 1 with maxDepth 2 still returns tools", () => {
    const tools = createDelegationTools(
      TEST_TYPES,
      mockManager as never,
      TEST_PARENT_AGENT_ID,
      1,
      2,
    );

    expect(tools).toHaveLength(2);
  });
});

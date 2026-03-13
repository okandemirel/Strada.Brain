import { describe, it, expect } from "vitest";
import {
  checkReadOnlyBlock,
  createReadOnlyToolStub,
  getReadOnlySystemPrompt,
  getReadOnlyToolSummary,
  filterToolsForReadOnly,
  ReadOnlyGuard,
  WRITE_TOOLS,
  READ_TOOLS,
} from "./read-only-guard.js";

describe("checkReadOnlyBlock", () => {
  it("should allow all tools when read-only mode is disabled", () => {
    const result = checkReadOnlyBlock("file_write", false);
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should block write tools in read-only mode", () => {
    const writeTools = ["file_write", "file_edit", "file_delete", "git_commit", "shell_exec"];

    for (const tool of writeTools) {
      const result = checkReadOnlyBlock(tool, true);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain(tool);
      expect(result.suggestion).toBeDefined();
    }
  });

  it("should allow read tools in read-only mode", () => {
    const readTools = ["file_read", "code_search", "git_status", "dotnet_build"];

    for (const tool of readTools) {
      const result = checkReadOnlyBlock(tool, true);
      expect(result.allowed).toBe(true);
    }
  });

  it("should provide helpful suggestions for blocked tools", () => {
    const testCases: Array<[string, string]> = [
      ["file_write", "file_read"],
      ["shell_exec", "built-in read tools"],
      ["git_commit", "git_status"],
    ];

    for (const [tool, expectedHint] of testCases) {
      const result = checkReadOnlyBlock(tool, true);
      expect(result.suggestion).toContain(expectedHint);
    }
  });

  it("should handle unknown tools gracefully", () => {
    const result = checkReadOnlyBlock("unknown_tool_xyz", true);
    expect(result.allowed).toBe(true);
  });

  it("should normalize tool names", () => {
    const result1 = checkReadOnlyBlock("FILE_WRITE", true);
    const result2 = checkReadOnlyBlock("File_Write", true);
    const result3 = checkReadOnlyBlock("  file_write  ", true);

    // Note: Current implementation does case normalization
    // If it doesn't, adjust this test
    expect(result1.allowed).toBe(false);
    expect(result2.allowed).toBe(false);
    expect(result3.allowed).toBe(false);
  });
});

describe("createReadOnlyToolStub", () => {
  it("should create error result for blocked tool", () => {
    const result = createReadOnlyToolStub("file_write", "call-123");

    expect(result.toolCallId).toBe("call-123");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("disabled in read-only mode");
    expect(result.content).toContain("READ_ONLY_MODE");
  });

  it("should include suggestion in content", () => {
    const result = createReadOnlyToolStub("shell_exec", "call-456");

    expect(result.content).toContain("💡");
    expect(result.content).toContain("Shell commands are disabled");
  });

  it("should use tool name in error message", () => {
    const result = createReadOnlyToolStub("git_commit", "call-789");

    expect(result.content).toContain("git_commit");
    expect(result.content).toContain("read-only mode");
  });
});

describe("getReadOnlySystemPrompt", () => {
  it("should return non-empty prompt", () => {
    const prompt = getReadOnlySystemPrompt();

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("READ-ONLY MODE");
  });

  it("should list blocked operations", () => {
    const prompt = getReadOnlySystemPrompt();

    expect(prompt).toContain("disabled");
    expect(prompt).toContain("Blocked Operations");
    expect(prompt).toContain("Available Operations");
  });

  it("should include guidance for the LLM", () => {
    const prompt = getReadOnlySystemPrompt();

    expect(prompt).toContain("How to Help");
    expect(prompt).toContain("Analyze");
    expect(prompt).toContain("Explain");
  });
});

describe("getReadOnlyToolSummary", () => {
  it("should return tool lists", () => {
    const summary = getReadOnlyToolSummary();

    expect(Array.isArray(summary.blocked)).toBe(true);
    expect(Array.isArray(summary.allowed)).toBe(true);
    expect(summary.totalBlocked).toBeGreaterThan(0);
    expect(summary.totalAllowed).toBeGreaterThan(0);
  });

  it("should include expected write tools", () => {
    const summary = getReadOnlyToolSummary();

    expect(summary.blocked).toContain("file_write");
    expect(summary.blocked).toContain("file_edit");
    expect(summary.blocked).toContain("shell_exec");
    expect(summary.blocked).toContain("git_commit");
  });

  it("should include expected read tools", () => {
    const summary = getReadOnlyToolSummary();

    expect(summary.allowed).toContain("file_read");
    expect(summary.allowed).toContain("code_search");
    expect(summary.allowed).toContain("git_status");
  });
});

describe("filterToolsForReadOnly", () => {
  interface MockTool {
    name: string;
    description: string;
  }

  const mockTools: MockTool[] = [
    { name: "file_read", description: "Read a file" },
    { name: "file_write", description: "Write a file" },
    { name: "code_search", description: "Search code" },
    { name: "shell_exec", description: "Execute shell" },
    { name: "git_status", description: "Git status" },
    { name: "git_commit", description: "Git commit" },
  ];

  it("should return all tools when not in read-only mode", () => {
    const filtered = filterToolsForReadOnly(mockTools, false);

    expect(filtered).toHaveLength(6);
    expect(filtered.map((t) => t.name)).toContain("file_write");
    expect(filtered.map((t) => t.name)).toContain("shell_exec");
  });

  it("should filter out write tools in read-only mode", () => {
    const filtered = filterToolsForReadOnly(mockTools, true);
    const names = filtered.map((t) => t.name);

    expect(names).toContain("file_read");
    expect(names).toContain("code_search");
    expect(names).toContain("git_status");
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("shell_exec");
    expect(names).not.toContain("git_commit");
  });

  it("should handle empty tool list", () => {
    const filtered = filterToolsForReadOnly([], true);
    expect(filtered).toHaveLength(0);
  });

  it("should not modify original array", () => {
    const original = [...mockTools];
    filterToolsForReadOnly(mockTools, true);

    expect(mockTools).toHaveLength(original.length);
  });
});

describe("ReadOnlyGuard class", () => {
  describe("isEnabled", () => {
    it("should return true when enabled", () => {
      const guard = new ReadOnlyGuard(true);
      expect(guard.isEnabled()).toBe(true);
    });

    it("should return false when disabled", () => {
      const guard = new ReadOnlyGuard(false);
      expect(guard.isEnabled()).toBe(false);
    });
  });

  describe("canExecute", () => {
    it("should allow all tools when disabled", () => {
      const guard = new ReadOnlyGuard(false);

      expect(guard.canExecute("file_write")).toBe(true);
      expect(guard.canExecute("shell_exec")).toBe(true);
      expect(guard.canExecute("file_read")).toBe(true);
    });

    it("should block write tools when enabled", () => {
      const guard = new ReadOnlyGuard(true);

      expect(guard.canExecute("file_write")).toBe(false);
      expect(guard.canExecute("shell_exec")).toBe(false);
      expect(guard.canExecute("git_commit")).toBe(false);
    });

    it("should allow read tools when enabled", () => {
      const guard = new ReadOnlyGuard(true);

      expect(guard.canExecute("file_read")).toBe(true);
      expect(guard.canExecute("code_search")).toBe(true);
      expect(guard.canExecute("git_status")).toBe(true);
    });
  });

  describe("check", () => {
    it("should return detailed results", () => {
      const guard = new ReadOnlyGuard(true);
      const result = guard.check("file_write");

      expect(result.allowed).toBe(false);
      expect(result.error).toContain("file_write");
      expect(result.suggestion).toBeDefined();
    });

    it("should allow when disabled", () => {
      const guard = new ReadOnlyGuard(false);
      const result = guard.check("file_write");

      expect(result.allowed).toBe(true);
    });
  });

  describe("getSystemPrompt", () => {
    it("should return prompt when enabled", () => {
      const guard = new ReadOnlyGuard(true);
      const prompt = guard.getSystemPrompt();

      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain("READ-ONLY");
    });

    it("should return empty string when disabled", () => {
      const guard = new ReadOnlyGuard(false);
      const prompt = guard.getSystemPrompt();

      expect(prompt).toBe("");
    });
  });

  describe("createStub", () => {
    it("should create stub result", () => {
      const guard = new ReadOnlyGuard(true);
      const stub = guard.createStub("file_write", "call-1");

      expect(stub.toolCallId).toBe("call-1");
      expect(stub.isError).toBe(true);
      expect(stub.content).toContain("disabled");
    });
  });

  describe("filterTools", () => {
    interface Tool {
      name: string;
      description: string;
    }

    const tools: Tool[] = [
      { name: "file_read", description: "Read" },
      { name: "file_write", description: "Write" },
    ];

    it("should filter tools when enabled", () => {
      const guard = new ReadOnlyGuard(true);
      const filtered = guard.filterTools(tools);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("file_read");
    });

    it("should not filter when disabled", () => {
      const guard = new ReadOnlyGuard(false);
      const filtered = guard.filterTools(tools);

      expect(filtered).toHaveLength(2);
    });
  });

  describe("additional blocked tools", () => {
    it("should support custom blocked tools", () => {
      const guard = new ReadOnlyGuard(true, ["custom_dangerous_tool"]);

      expect(guard.canExecute("custom_dangerous_tool")).toBe(false);
      expect(guard.canExecute("file_read")).toBe(true);
    });
  });

  describe("assertWritable", () => {
    it("should not throw when disabled", () => {
      const guard = new ReadOnlyGuard(false);
      expect(() => guard.assertWritable("file_write")).not.toThrow();
    });

    it("should throw when enabled", () => {
      const guard = new ReadOnlyGuard(true);
      expect(() => guard.assertWritable("file_write")).toThrow(
        "Operation 'file_write' blocked: system is in read-only mode",
      );
    });

    it("should include operation name in error message", () => {
      const guard = new ReadOnlyGuard(true);
      expect(() => guard.assertWritable("deploy_production")).toThrow("deploy_production");
    });
  });
});

describe("WRITE_TOOLS set", () => {
  it("should contain expected write tools", () => {
    expect(WRITE_TOOLS.has("file_write")).toBe(true);
    expect(WRITE_TOOLS.has("file_edit")).toBe(true);
    expect(WRITE_TOOLS.has("file_delete")).toBe(true);
    expect(WRITE_TOOLS.has("file_rename")).toBe(true);
    expect(WRITE_TOOLS.has("file_delete_directory")).toBe(true);
    expect(WRITE_TOOLS.has("git_commit")).toBe(true);
    expect(WRITE_TOOLS.has("git_push")).toBe(true);
    expect(WRITE_TOOLS.has("shell_exec")).toBe(true);
    expect(WRITE_TOOLS.has("strada_create_module")).toBe(true);
    expect(WRITE_TOOLS.has("strada_create_component")).toBe(true);
    expect(WRITE_TOOLS.has("strada_create_mediator")).toBe(true);
    expect(WRITE_TOOLS.has("strada_create_system")).toBe(true);
  });

  it("should not contain read tools", () => {
    expect(WRITE_TOOLS.has("file_read")).toBe(false);
    expect(WRITE_TOOLS.has("code_search")).toBe(false);
    expect(WRITE_TOOLS.has("git_status")).toBe(false);
  });
});

describe("READ_TOOLS set", () => {
  it("should contain expected read tools", () => {
    expect(READ_TOOLS.has("file_read")).toBe(true);
    expect(READ_TOOLS.has("code_search")).toBe(true);
    expect(READ_TOOLS.has("git_status")).toBe(true);
    expect(READ_TOOLS.has("git_log")).toBe(true);
    expect(READ_TOOLS.has("dotnet_build")).toBe(true);
    expect(READ_TOOLS.has("dotnet_test")).toBe(true);
  });

  it("should not contain write tools", () => {
    expect(READ_TOOLS.has("file_write")).toBe(false);
    expect(READ_TOOLS.has("shell_exec")).toBe(false);
    expect(READ_TOOLS.has("git_commit")).toBe(false);
  });
});

describe("Integration scenarios", () => {
  it("should handle realistic orchestrator scenario", () => {
    // Simulate what orchestrator does
    const guard = new ReadOnlyGuard(true);
    const toolCalls = [
      { id: "call-1", name: "file_read", input: { path: "test.cs" } },
      { id: "call-2", name: "file_write", input: { path: "output.cs", content: "..." } },
      { id: "call-3", name: "shell_exec", input: { command: "ls" } },
    ];

    const results = toolCalls.map((call) => {
      const check = guard.check(call.name);
      if (!check.allowed) {
        return guard.createStub(call.name, call.id);
      }
      // Would normally execute tool
      return { toolCallId: call.id, content: "Success", isError: false };
    });

    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true);
    expect(results[2].isError).toBe(true);
    expect(results[1].content).toContain("disabled");
    expect(results[2].content).toContain("disabled");
  });

  it("should handle mixed read-write operations in disabled mode", () => {
    const guard = new ReadOnlyGuard(false);

    expect(guard.canExecute("file_read")).toBe(true);
    expect(guard.canExecute("file_write")).toBe(true);
    expect(guard.canExecute("shell_exec")).toBe(true);
    expect(guard.getSystemPrompt()).toBe("");
  });
});

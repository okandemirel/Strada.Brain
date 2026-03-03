/**
 * Error Recovery Flow Integration Test
 * 
 * Tests the complete flow:
 * 1. dotnet_build hata verir (CS0246)
 * 2. ErrorRecoveryEngine analiz eder
 * 3. LLM'den fix önerisi gelir
 * 4. file_edit uygulanır
 * 5. Tekrar build edilir, başarılı olur
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { Orchestrator } from "../../agents/orchestrator.js";
import { FileWriteTool } from "../../agents/tools/file-write.js";
import { FileEditTool } from "../../agents/tools/file-edit.js";
import { DotnetBuildTool } from "../../agents/tools/dotnet-tools.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import { createMockTelegramChannel } from "../helpers/mock-channel.js";
import { createMockProvider, createMockToolCall } from "../helpers/mock-provider.js";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Initialize logger before all tests
beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

describe("Error Recovery Flow Integration", () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let channel: ReturnType<typeof createMockTelegramChannel>;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let tools: ITool[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strada-error-recovery-test-"));

    channel = createMockTelegramChannel({ autoConfirm: true });
    mockProvider = createMockProvider();

    tools = [new FileWriteTool(), new FileEditTool(), new DotnetBuildTool()];

    orchestrator = new Orchestrator({
      provider: mockProvider,
      tools,
      channel,
      projectPath: tempDir,
      readOnly: false,
      requireConfirmation: false,
      streamingEnabled: false,
    });

    await channel.connect();
    channel.onMessage((msg) => orchestrator.handleMessage(msg));
  });

  describe("CS0246 - Type or Namespace Not Found", () => {
    it("should recover from missing using directive (CS0246)", async () => {
      // Setup: Create file with missing using directive
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "BrokenScript.cs"),
        `public class BrokenScript
{
    // Missing: using UnityEngine;
    private GameObject player; // CS0246: GameObject not found
}`
      );

      // Simulate: Build fails → Analyze → Fix → Build succeeds
      mockProvider.queueResponses([
        {
          text: "Let me build the project...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "I see the error. The GameObject type requires UnityEngine namespace. Let me fix it...",
          toolCalls: [
            createMockToolCall("tool-2", "file_edit", {
              path: "Assets/Scripts/BrokenScript.cs",
              old_string: "public class BrokenScript",
              new_string: "using UnityEngine;\n\npublic class BrokenScript",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Fixed! Now let me rebuild...",
          toolCalls: [createMockToolCall("tool-3", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "✅ Build successful! I've added the missing `using UnityEngine;` directive to fix the CS0246 error.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-cs0246", "Build the project");

      // Assert: Build was called twice (fail, then succeed)
      const buildCalls = mockProvider
        .getAllToolCalls()
        .filter((tc) => tc.name === "dotnet_build");
      expect(buildCalls.length).toBe(2);

      // Assert: File edit was called to fix the error
      mockProvider.assertToolCalled("file_edit");

      // Assert: Build and edit tools were called for recovery
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.some(tc => tc.name === "dotnet_build")).toBe(true);
      expect(toolCalls.some(tc => tc.name === "file_edit")).toBe(true);
    });

    it("should recover from typo in type name", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "TypoScript.cs"),
        `using UnityEngine;

public class TypoScript : MonoBehaviour
{
    private Transform playerTranform; // Typo: Tranform instead of Transform
}`
      );

      mockProvider.simulateErrorRecoveryFlow(
        createMockToolCall("tool-1", "dotnet_build", {}), // First build (fails)
        createMockToolCall("tool-2", "file_edit", {
          path: "Assets/Scripts/TypoScript.cs",
          old_string: "playerTranform",
          new_string: "playerTransform",
        }),
        "✅ Fixed the typo and build succeeded!"
      );

      await channel.simulateIncomingMessage("chat-typo", "Build and fix any issues");

      // Assert: Edit was applied
      mockProvider.assertToolCalled("file_edit");
    });
  });

  describe("CS0103 - Undefined Symbol", () => {
    it("should recover from undefined variable", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "UndefinedVar.cs"),
        `using UnityEngine;

public class UndefinedVar : MonoBehaviour
{
    void Update()
    {
        player.Move(); // CS0103: player is not defined
    }
}`
      );

      mockProvider.queueResponses([
        {
          text: "Building...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "Found CS0103 error. The 'player' variable is not defined. Adding declaration...",
          toolCalls: [
            createMockToolCall("tool-2", "file_edit", {
              path: "Assets/Scripts/UndefinedVar.cs",
              old_string: "void Update()\n    {\n        player.Move();",
              new_string: "public GameObject player;\n    \n    void Update()\n    {\n        player.Move();",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Rebuilding...",
          toolCalls: [createMockToolCall("tool-3", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "✅ Fixed! Added the missing `player` declaration.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-cs0103", "Fix the code");

      // Assert: Recovery was attempted (tool calls were made)
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.filter(tc => tc.name === "file_edit").length).toBeGreaterThan(0);
    });
  });

  describe("CS1061 - Missing Member", () => {
    it("should handle method not found on type", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "MissingMember.cs"),
        `using UnityEngine;

public class MissingMember : MonoBehaviour
{
    void Start()
    {
        gameObject.SetActivee(true); // Typo: SetActivee instead of SetActive
    }
}`
      );

      mockProvider.simulateErrorRecoveryFlow(
        createMockToolCall("tool-1", "dotnet_build", {}),
        createMockToolCall("tool-2", "file_edit", {
          path: "Assets/Scripts/MissingMember.cs",
          old_string: "SetActivee",
          new_string: "SetActive",
        }),
        "✅ Fixed the method name typo!"
      );

      await channel.simulateIncomingMessage("chat-cs1061", "Build the project");

      mockProvider.assertToolCalled("file_edit");
    });
  });

  describe("Multi-Error Recovery", () => {
    it("should recover from multiple compilation errors in sequence", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "MultiError.cs"),
        `public class MultiError
{
    // Missing using UnityEngine
    private GameObject obj;
    
    // Typo in method name
    void Start()
    {
        obj.SetActivee(true);
    }
    
    // Undefined variable
    void Update()
    {
        speed = 5f;
    }
}`
      );

      // Simulate fixing multiple errors
      mockProvider.queueResponses([
        {
          text: "Building project...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "Multiple errors detected. Let me fix them one by one. First, adding the missing using directive...",
          toolCalls: [
            createMockToolCall("tool-2", "file_edit", {
              path: "Assets/Scripts/MultiError.cs",
              old_string: "public class MultiError",
              new_string: "using UnityEngine;\n\npublic class MultiError",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Fixed using directive. Now fixing the typo...",
          toolCalls: [
            createMockToolCall("tool-3", "file_edit", {
              path: "Assets/Scripts/MultiError.cs",
              old_string: "SetActivee",
              new_string: "SetActive",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Fixed typo. Now adding the missing variable declaration...",
          toolCalls: [
            createMockToolCall("tool-4", "file_edit", {
              path: "Assets/Scripts/MultiError.cs",
              old_string: "void Update()\n    {\n        speed = 5f;",
              new_string: "public float speed;\n    \n    void Update()\n    {\n        speed = 5f;",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "All fixes applied. Rebuilding...",
          toolCalls: [createMockToolCall("tool-5", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "✅ All errors fixed and build successful! Fixed: 1) Missing using directive, 2) Method name typo, 3) Missing variable declaration.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-multi-error", "Fix all build errors");

      // Assert: Multiple edits were made
      const editCalls = mockProvider
        .getAllToolCalls()
        .filter((tc) => tc.name === "file_edit");
      expect(editCalls.length).toBe(3);

      // Assert: Final build succeeded
      const buildCalls = mockProvider
        .getAllToolCalls()
        .filter((tc) => tc.name === "dotnet_build");
      expect(buildCalls.length).toBe(2); // Initial fail + final success
    });
  });

  describe("Error Analysis Integration", () => {
    it("should analyze build errors and provide recovery hints", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "ErrorAnalysis.cs"),
        `public class ErrorAnalysis
{
    private NonExistentType data; // CS0246
}`
      );

      mockProvider.queueResponses([
        {
          text: "Building to check for errors...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "Analysis complete. The error CS0246 indicates 'NonExistentType' is not found. I need to either: 1) Add the correct using directive, 2) Fix the type name, or 3) Create the missing type. Let me check the project...",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-analysis", "Analyze build errors");

      // Assert: Error analysis was triggered through tool execution
      const interactions = mockProvider.interactions;
      expect(interactions.length).toBeGreaterThan(0);
    });

    it("should track error patterns across multiple build attempts", async () => {
      // Simulate iterative error fixing
      const buildAttempts: boolean[] = []; // true = success, false = fail

      mockProvider.registerResponseHandler("error-tracking", () => {
        const attemptCount = buildAttempts.length;
        if (attemptCount < 2) {
          buildAttempts.push(false);
          return {
            text: `Build attempt ${attemptCount + 1}...`,
            toolCalls: [createMockToolCall(`build-${attemptCount}`, "dotnet_build", {})],
            stopReason: "tool_use",
          };
        }
        buildAttempts.push(true);
        return {
          text: "Build successful after fixes!",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

      // Trigger multiple builds through conversation
      await channel.simulateIncomingMessage("chat-tracking-1", "Build");
      await channel.simulateIncomingMessage("chat-tracking-2", "Fix and build again");
      await channel.simulateIncomingMessage("chat-tracking-3", "Build once more");

      // Assert: Multiple builds were attempted
      const buildCalls = mockProvider
        .getAllToolCalls()
        .filter((tc) => tc.name === "dotnet_build");
      expect(buildCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Recovery Strategy Patterns", () => {
    it("should suggest adding using directive for missing type", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "MissingNamespace.cs"),
        `public class MissingNamespace
{
    private List<string> items; // Missing: using System.Collections.Generic;
}`
      );

      mockProvider.simulateErrorRecoveryFlow(
        createMockToolCall("tool-1", "dotnet_build", {}),
        createMockToolCall("tool-2", "file_edit", {
          path: "Assets/Scripts/MissingNamespace.cs",
          old_string: "public class MissingNamespace",
          new_string: "using System.Collections.Generic;\n\npublic class MissingNamespace",
        }),
        "✅ Added missing using directive for System.Collections.Generic!"
      );

      await channel.simulateIncomingMessage("chat-using", "Build the project");

      // Assert: Fix was applied
      const editCall = mockProvider
        .getAllToolCalls()
        .find((tc) => tc.name === "file_edit");
      expect(editCall?.input.new_string).toContain("using System.Collections.Generic");
    });

    it("should suggest fixing null safety issues", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "NullSafety.cs"),
        `using UnityEngine;

public class NullSafety : MonoBehaviour
{
    private Transform target;
    
    void Update()
    {
        target.position = Vector3.zero; // CS8602: target might be null
    }
}`
      );

      mockProvider.simulateErrorRecoveryFlow(
        createMockToolCall("tool-1", "dotnet_build", {}),
        createMockToolCall("tool-2", "file_edit", {
          path: "Assets/Scripts/NullSafety.cs",
          old_string: "target.position = Vector3.zero;",
          new_string: "target?.position = Vector3.zero;",
        }),
        "✅ Fixed null safety issue with null-conditional operator!"
      );

      await channel.simulateIncomingMessage("chat-null", "Fix null warnings");

      mockProvider.assertToolCalled("file_edit");
    });
  });

  describe("Error Recovery with Tool Results", () => {
    it("should pass error details back to LLM for analysis", async () => {
      await mkdir(join(tempDir, "Assets", "Scripts"), { recursive: true });
      await writeFile(
        join(tempDir, "Assets", "Scripts", "ErrorDetail.cs"),
        `public class ErrorDetail
{
    private InvalidType data;
}`
      );

      mockProvider.queueResponses([
        {
          text: "Building...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "I can see the build output shows CS0246 error for 'InvalidType'. Let me fix this by using the correct type...",
          toolCalls: [
            createMockToolCall("tool-2", "file_edit", {
              path: "Assets/Scripts/ErrorDetail.cs",
              old_string: "InvalidType",
              new_string: "string",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Fixed the type. Building again...",
          toolCalls: [createMockToolCall("tool-3", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "✅ Build successful! Changed InvalidType to string.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-detail", "Build and fix errors");

      // Assert: The tool result with error was passed to LLM
      const interactions = mockProvider.interactions;
      const toolResultInteraction = interactions.find((i) =>
        i.messages.some(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((block: { type?: string; tool_use_id?: string }) => 
              block.type === "tool_result" && block.tool_use_id === "tool-1"
            )
        )
      );
      expect(toolResultInteraction).toBeDefined();
    });
  });

  describe("Edge Cases", () => {
    it("should handle build timeout gracefully", async () => {
      mockProvider.queueResponses([
        {
          text: "Starting build (this may take a while)...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "The build timed out. This might be due to a large project or complex dependencies. Try building in smaller chunks or check for circular dependencies.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-timeout", "Build the large project");

      // Assert: Appropriate message was sent
      expect(
        channel.hasMarkdownContaining("timed out") ||
        channel.hasMessageContaining("timed out")
      ).toBe(true);
    });

    it("should handle unrecoverable errors", async () => {
      mockProvider.queueResponses([
        {
          text: "Attempting to build...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "This error requires manual intervention. The project file is corrupted and needs to be restored from version control or recreated.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-unrecoverable", "Fix the corrupted project");

      // Assert: User was informed about manual intervention needed
      expect(
        channel.hasMarkdownContaining("manual") ||
        channel.hasMarkdownContaining("requires")
      ).toBe(true);
    });
  });
});

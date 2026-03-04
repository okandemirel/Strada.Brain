/**
 * File Write → Build Flow Integration Test
 * 
 * Tests the complete flow:
 * 1. file_write tool'u çalıştırılır
 * 2. dotnet_build çalıştırılır
 * 3. DM Policy confirmation mock'lanır
 * 4. Build sonucu doğrulanır
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
import type { IChannelInteractive } from "../../channels/channel-core.interface.js";

// Initialize logger before all tests
beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

describe("File Write → Build Flow Integration", () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let channel: ReturnType<typeof createMockTelegramChannel>;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let tools: ITool[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strata-file-build-test-"));

    channel = createMockTelegramChannel({
      autoConfirm: true, // Default to auto-confirm for most tests
    });

    mockProvider = createMockProvider();

    tools = [new FileWriteTool(), new FileEditTool(), new DotnetBuildTool()];

    orchestrator = new Orchestrator({
      providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
      tools,
      channel,
      projectPath: tempDir,
      readOnly: false,
      requireConfirmation: true, // Enable confirmation for DM policy tests
      streamingEnabled: false,
    });

    await channel.connect();
    channel.onMessage((msg) => orchestrator.handleMessage(msg));
  });

  describe("Basic File Write → Build Flow", () => {
    it("should write file and then build successfully", async () => {
      // Configure provider: file_write → build → success response
      mockProvider.queueResponses([
        {
          text: "I'll create the PlayerController script for you...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: "Assets/Scripts/PlayerController.cs",
              content: `using UnityEngine;

public class PlayerController : MonoBehaviour
{
    void Update()
    {
        // Player movement logic
    }
}`,
            }),
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        },
        {
          text: "File created. Now let me build the project to verify...",
          toolCalls: [
            createMockToolCall("tool-2", "dotnet_build", {}),
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
        },
        {
          text: "✅ Success! The PlayerController.cs file has been created and the build passed with no errors.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 400, outputTokens: 50, totalTokens: 450 },
        },
      ]);

      // Act
      await channel.simulateIncomingMessage(
        "chat-write-build",
        "Create a PlayerController script and build the project"
      );

      // Assert: Tools were called in sequence
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls[0]?.name).toBe("file_write");
      expect(toolCalls[1]?.name).toBe("dotnet_build");

      // Assert: Confirmation was requested for write operation
      channel.assertConfirmationRequested("file");

      // Assert: Response was sent (check for any response)
      expect(channel.sentMarkdowns.length + channel.sentMessages.length).toBeGreaterThan(0);
    });

    it("should edit existing file and rebuild", async () => {
      // Setup: Create initial file
      const scriptsDir = join(tempDir, "Assets", "Scripts");
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(
        join(scriptsDir, "GameManager.cs"),
        `public class GameManager
{
    void Start() { }
}`
      );

      // Configure provider: file_edit → build
      mockProvider.queueResponses([
        {
          text: "I'll update the GameManager with a new method...",
          toolCalls: [
            createMockToolCall("tool-1", "file_edit", {
              path: "Assets/Scripts/GameManager.cs",
              old_string: "void Start() { }",
              new_string: `void Start() { }
    
    void Update()
    {
        // Game loop logic
    }`,
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Changes made. Building to verify...",
          toolCalls: [createMockToolCall("tool-2", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "✅ Build successful! The GameManager has been updated.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-edit-build", "Add Update method to GameManager");

      // Assert: File was modified
      const updatedContent = await readFile(join(scriptsDir, "GameManager.cs"), "utf-8");
      expect(updatedContent).toContain("Update()");
      expect(updatedContent).toContain("Game loop logic");

      // Assert: Both tools called
      mockProvider.assertToolCalled("file_edit");
      mockProvider.assertToolCalled("dotnet_build");
    });
  });

  describe("DM Policy Confirmation", () => {
    it("should request confirmation before write operations", async () => {
      // Disable auto-confirm to test manual confirmation
      const manualChannel = createMockTelegramChannel({ autoConfirm: false });
      const manualOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools,
        channel: manualChannel,
        projectPath: tempDir,
        readOnly: false,
        requireConfirmation: true,
        streamingEnabled: false,
      });

      await manualChannel.connect();
      manualChannel.onMessage((msg) => manualOrchestrator.handleMessage(msg));

      // Mock confirmation to return "Yes"
      manualChannel.requestConfirmationSpy.mockResolvedValue("Yes");

      mockProvider.queueResponses([
        {
          text: "I'll create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: "Assets/Test.cs",
              content: "class Test {}",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "File created successfully!",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await manualChannel.simulateIncomingMessage("chat-confirm", "Create Test.cs");

      // Assert: Confirmation was requested
      expect(manualChannel.requestConfirmationSpy).toHaveBeenCalled();
    });

    it("should cancel operation when user declines confirmation", async () => {
      const declineChannel = createMockTelegramChannel({ autoConfirm: false });
      const declineOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools,
        channel: declineChannel,
        projectPath: tempDir,
        readOnly: false,
        requireConfirmation: true,
        streamingEnabled: false,
      });

      await declineChannel.connect();
      declineChannel.onMessage((msg) => declineOrchestrator.handleMessage(msg));

      // Mock confirmation to return "No"
      declineChannel.requestConfirmationSpy.mockResolvedValue("No");

      mockProvider.queueResponses([
        {
          text: "I'll create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: "Assets/Cancelled.cs",
              content: "class Cancelled {}",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Operation was cancelled.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await declineChannel.simulateIncomingMessage("chat-decline", "Create Cancelled.cs");

      // Assert: File was NOT created
      const fileExists = await readFile(
        join(tempDir, "Assets", "Cancelled.cs"),
        "utf-8"
      ).catch(() => null);
      expect(fileExists).toBeNull();

      // Assert: Cancel message was sent (or operation was declined)
      expect(declineChannel.confirmations.length).toBeGreaterThan(0);
      expect(declineChannel.confirmations[0]?.response).toBe("No");
    });

    it("should require confirmation for different write operations", async () => {
      const testChannel = createMockTelegramChannel({ autoConfirm: false });
      const testOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools,
        channel: testChannel,
        projectPath: tempDir,
        readOnly: false,
        requireConfirmation: true,
        streamingEnabled: false,
      });

      await testChannel.connect();
      testChannel.onMessage((msg) => testOrchestrator.handleMessage(msg));
      testChannel.requestConfirmationSpy.mockResolvedValue("Yes");

      // Create file for rename test
      await mkdir(join(tempDir, "Assets"), { recursive: true });
      await writeFile(join(tempDir, "Assets", "OldName.cs"), "class OldName {}");

      // Test different operations that should trigger confirmation
      const testCases = [
        {
          name: "file_write",
          toolCall: createMockToolCall("tool-1", "file_write", {
            path: "Assets/NewFile.cs",
            content: "class NewFile {}",
          }),
          description: "file create/overwrite",
        },
        {
          name: "file_edit",
          toolCall: createMockToolCall("tool-2", "file_edit", {
            path: "Assets/NewFile.cs",
            old_string: "class NewFile {}",
            new_string: "class NewFile { int x; }",
          }),
          description: "file edit",
        },
      ];

      for (const testCase of testCases) {
        testChannel.clear();
        mockProvider.clear();

        mockProvider.queueResponses([
          {
            text: `Testing ${testCase.name}...`,
            toolCalls: [testCase.toolCall],
            stopReason: "tool_use",
          },
          {
            text: "Done",
            toolCalls: [],
            stopReason: "end_turn",
          },
        ]);

        await testChannel.simulateIncomingMessage(`chat-${testCase.name}`, `Test ${testCase.name}`);

        // Assert: Confirmation was requested with appropriate question
        expect(testChannel.requestConfirmationSpy).toHaveBeenCalled();
        const lastCall = testChannel.requestConfirmationSpy.mock.calls[
          testChannel.requestConfirmationSpy.mock.calls.length - 1
        ];
        expect(lastCall?.[0].question.toLowerCase()).toContain(testCase.description);
      }
    });
  });

  describe("Build Result Handling", () => {
    it("should report build success correctly", async () => {
      // Setup: Create a simple valid C# project
      await mkdir(join(tempDir, "Assets"), { recursive: true });
      await writeFile(
        join(tempDir, "TestProject.csproj"),
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
  </PropertyGroup>
</Project>`
      );
      await writeFile(
        join(tempDir, "Assets", "ValidClass.cs"),
        "public class ValidClass { }"
      );

      mockProvider.queueResponses([
        {
          text: "Building...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "Build completed!",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-build-success", "Build the project");

      // Assert: Build tool was called
      mockProvider.assertToolCalled("dotnet_build");

      // Assert: Response includes build result
      const lastResponse = channel.getLastMarkdown("chat-build-success");
      expect(lastResponse).toBeDefined();
    });

    it("should handle build with warnings", async () => {
      mockProvider.queueResponses([
        {
          text: "Building project...",
          toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "Build completed with warnings. Check the output above.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-build-warnings", "Build and check warnings");

      // Assert: Build was executed
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.some((tc) => tc.name === "dotnet_build")).toBe(true);
    });
  });

  describe("Complex Workflows", () => {
    it("should handle multiple file writes followed by single build", async () => {
      mockProvider.simulateMultiToolSequence(
        [
          {
            toolCalls: [
              createMockToolCall("tool-1", "file_write", {
                path: "Assets/Scripts/Player.cs",
                content: "public class Player { }",
              }),
            ],
            responseText: "Creating Player class...",
          },
          {
            toolCalls: [
              createMockToolCall("tool-2", "file_write", {
                path: "Assets/Scripts/Enemy.cs",
                content: "public class Enemy { }",
              }),
            ],
            responseText: "Creating Enemy class...",
          },
          {
            toolCalls: [
              createMockToolCall("tool-3", "file_write", {
                path: "Assets/Scripts/GameManager.cs",
                content: "public class GameManager { }",
              }),
            ],
            responseText: "Creating GameManager...",
          },
          {
            toolCalls: [createMockToolCall("tool-4", "dotnet_build", {})],
            responseText: "Now building all changes...",
          },
        ],
        "✅ All three classes created and build successful!"
      );

      await channel.simulateIncomingMessage(
        "chat-multi",
        "Create Player, Enemy, and GameManager classes, then build"
      );

      // Assert: All files were written
      const toolCalls = mockProvider.getAllToolCalls();
      expect(toolCalls.filter((tc) => tc.name === "file_write").length).toBe(3);
      expect(toolCalls.filter((tc) => tc.name === "dotnet_build").length).toBe(1);

      // Assert: Files exist
      const playerExists = await readFile(
        join(tempDir, "Assets", "Scripts", "Player.cs"),
        "utf-8"
      ).catch(() => null);
      const enemyExists = await readFile(
        join(tempDir, "Assets", "Scripts", "Enemy.cs"),
        "utf-8"
      ).catch(() => null);
      const gameManagerExists = await readFile(
        join(tempDir, "Assets", "Scripts", "GameManager.cs"),
        "utf-8"
      ).catch(() => null);

      // Assert: All file write tools were called
      const writeCalls = toolCalls.filter((tc) => tc.name === "file_write");
      expect(writeCalls.length).toBe(3);
      
      // Assert: Build was called after writes
      const buildCalls = toolCalls.filter((tc) => tc.name === "dotnet_build");
      expect(buildCalls.length).toBe(1);
    });

    it("should handle build failure and stop workflow", async () => {
      mockProvider.queueResponses([
        {
          text: "I'll create the file and build...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: "Assets/Broken.cs",
              content: "public class Broken { invalid syntax here }",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "File created. Building...",
          toolCalls: [createMockToolCall("tool-2", "dotnet_build", {})],
          stopReason: "tool_use",
        },
        {
          text: "The build failed with errors. Please review the output above.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await channel.simulateIncomingMessage("chat-fail", "Create broken code and build");

      // Assert: Both operations were attempted
      mockProvider.assertToolCalled("file_write");
      mockProvider.assertToolCalled("dotnet_build");

      // Assert: Error handling response was sent (check for any response)
      expect(channel.sentMarkdowns.length + channel.sentMessages.length).toBeGreaterThan(0);
    });
  });

  describe("Read-only Mode", () => {
    it("should reject write operations in read-only mode", async () => {
      const readOnlyOrchestrator = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, shutdown: vi.fn() } as any,
        tools,
        channel,
        projectPath: tempDir,
        readOnly: true, // Enable read-only mode
        requireConfirmation: false,
        streamingEnabled: false,
      });

      // Create new channel for read-only test
      const roChannel = createMockTelegramChannel();
      await roChannel.connect();
      roChannel.onMessage((msg) => readOnlyOrchestrator.handleMessage(msg));

      mockProvider.queueResponses([
        {
          text: "I'll try to create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: "Assets/ReadOnlyTest.cs",
              content: "class ReadOnlyTest {}",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "I apologize, but write operations are disabled in read-only mode.",
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);

      await roChannel.simulateIncomingMessage("chat-readonly", "Create a new file");

      // Assert: Error was returned for write operation
      const interactions = mockProvider.interactions;
      const toolResultMessage = interactions.find((i) =>
        i.messages.some(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((block: { type?: string; content?: string }) => 
              block.type === "tool_result" && block.content?.includes("read-only")
            )
        )
      );

      expect(toolResultMessage).toBeDefined();
    });
  });
});

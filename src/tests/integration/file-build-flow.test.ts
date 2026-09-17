/**
 * File Write → Build Flow Integration Test
 *
 * What this suite is for: proving that a run which says it wrote a file and
 * built the project actually did both — the file's bytes on disk, and the
 * build's own verdict.
 *
 * It did not do that. Measured 2026-09-17, at HEAD, with the suite enabled
 * (`LOCAL_DOTNET_TESTS=1`): five of its ten tests failed, and the other five
 * passed while verifying nothing. Two causes:
 *
 *   - Every "did it work" assertion read `mockProvider.getAllToolCalls()`,
 *     which returns the tool calls the MOCK WAS SCRIPTED TO ASK FOR. A name is
 *     in that list because the test put it there, so the assertion holds
 *     whether or not the tool ran, succeeded, or failed. `should report build
 *     success correctly` passed green on a temp directory with no project in
 *     it, where `dotnet build` had never produced anything.
 *   - The write paths were not conformant (`Assets/Scripts/Foo.cs`), so the
 *     self-managed write review walled them before any prompt or write: Strada
 *     game code belongs under `Assets/Modules/<Name>Module/`. The tests that
 *     did fail, failed on that — the file they claimed to have written was
 *     never written, and no confirmation was ever requested.
 *
 * So the flows here now write to conformant paths and assert on
 * `getToolResults()` — the content the tool produced and, for a build, its own
 * exit verdict — with a negative twin for every positive claim: a broken
 * project must FAIL the same assertion a working one passes, or the assertion
 * measures nothing.
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { createLogger } from "../../utils/logger.js";
import { Orchestrator } from "../../agents/orchestrator.js";
import { FileWriteTool } from "../../agents/tools/file-write.js";
import { FileEditTool } from "../../agents/tools/file-edit.js";
import { DotnetBuildTool } from "../../agents/tools/dotnet-tools.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import { createMockTelegramChannel } from "../helpers/mock-channel.js";
import { createMockProvider, createMockToolCall } from "../helpers/mock-provider.js";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockChannelAdapter } from "../helpers/mock-channel.js";

// Initialize logger before all tests
beforeAll(() => {
  createLogger("error", "/tmp/strada-test.log");
});

// The real `dotnet build` stays an opt-in local suite: it shells out to the
// .NET SDK, which this repository does not depend on. Everything that does NOT
// need the SDK now runs unconditionally — the old flag hid the suite's own rot.
const runLocalDotnetTests = !!process.env["LOCAL_DOTNET_TESTS"];

/**
 * Strada's write review wall: compilable game code must live inside a module.
 * A loose `Assets/Scripts/Foo.cs` is rejected before it is ever written.
 */
const MODULE_DIR = join("Assets", "Modules", "GameplayModule");
const modulePath = (name: string): string => `Assets/Modules/GameplayModule/${name}`;

/** A minimal project the .NET SDK can build offline, in the test's temp dir. */
const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
  </PropertyGroup>
</Project>`;

interface Harness {
  tempDir: string;
  tools: ITool[];
  provider: ReturnType<typeof createMockProvider>;
  cleanupChannels: MockChannelAdapter[];
}

function createHarness(state: Harness, options: { autoConfirm?: boolean; readOnly?: boolean } = {}) {
  const channel = createMockTelegramChannel({ autoConfirm: options.autoConfirm ?? true });
  state.cleanupChannels.push(channel);
  const orchestrator = new Orchestrator({
    providerManager: { getProvider: () => state.provider, shutdown: vi.fn() } as any,
    tools: state.tools,
    channel,
    projectPath: state.tempDir,
    readOnly: options.readOnly ?? false,
    requireConfirmation: true,
    streamingEnabled: false,
  });
  return { channel, orchestrator };
}

describe("File Write → Build Flow Integration", { timeout: 30_000 }, () => {
  const state: Harness = {
    tempDir: "",
    tools: [],
    provider: null as unknown as ReturnType<typeof createMockProvider>,
    cleanupChannels: [],
  };
  let channel: ReturnType<typeof createMockTelegramChannel>;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(async () => {
    state.tempDir = await mkdtemp(join(tmpdir(), "strada-file-build-test-"));
    state.cleanupChannels = [];
    state.provider = createMockProvider();
    state.tools = [new FileWriteTool(), new FileEditTool(), new DotnetBuildTool()];
    mockProvider = state.provider;

    const harness = createHarness(state, { autoConfirm: true });
    channel = harness.channel;
    await channel.connect();
    channel.onMessage((msg) => harness.orchestrator.handleMessage(msg));
  });

  afterEach(async () => {
    mockProvider?.clear();
    for (const testChannel of state.cleanupChannels) {
      testChannel.clear();
      await testChannel.disconnect();
    }
    if (state.tempDir) {
      await rm(state.tempDir, { recursive: true, force: true });
    }
  });

  describe("What the run actually produced", () => {
    it("writes the file the run asked for, and reports the tool's own result", async () => {
      mockProvider.queueResponses([
        {
          text: "I'll create the PlayerController script for you...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: modulePath("PlayerController.cs"),
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
        },
        { text: "File created.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await channel.simulateIncomingMessage(
        "chat-write",
        "Create a PlayerController script in the gameplay module"
      );

      // THE WRITE HAPPENED: the tool's own result, not the scripted request.
      const write = mockProvider.getToolResult("file_write");
      expect(write).toBeDefined();
      expect(write?.isError).toBe(false);
      expect(write?.content).toContain("PlayerController.cs");

      // …and the bytes are on disk, which is the claim that result makes.
      const onDisk = await readFile(join(state.tempDir, MODULE_DIR, "PlayerController.cs"), "utf-8");
      expect(onDisk).toContain("class PlayerController");
      expect(onDisk).toContain("Player movement logic");

      // Confirmation was requested for the write operation.
      channel.assertConfirmationRequested("file");
    });

    it("a scripted tool name is not evidence: a walled write names the tool and writes nothing", async () => {
      // The guard for this whole suite's defect. `Assets/Scripts/Loose.cs` is
      // exactly what the old tests used: the conformance review rejects it, so
      // no file is created — and `getAllToolCalls()` still reports `file_write`
      // as "called", because the mock was asked for it. Only the RESULT can
      // tell a write that happened from a write that was refused.
      mockProvider.queueResponses([
        {
          text: "I'll create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: "Assets/Scripts/Loose.cs",
              content: "public class Loose { }",
            }),
          ],
          stopReason: "tool_use",
        },
        { text: "Done.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await channel.simulateIncomingMessage("chat-names", "Create Loose.cs");

      // The old assertion still passes…
      expect(mockProvider.getAllToolCalls().some((tc) => tc.name === "file_write")).toBe(true);
      // …while the result says the write was refused, and nothing is on disk.
      const write = mockProvider.getToolResult("file_write");
      expect(write).toBeDefined();
      expect(write?.isError).toBe(true);
      expect(write?.content).toContain("rejected");
      await expect(
        readFile(join(state.tempDir, "Assets", "Scripts", "Loose.cs"), "utf-8")
      ).rejects.toThrow();
    });

    it("edits an existing file and reports what changed", async () => {
      const moduleDir = join(state.tempDir, MODULE_DIR);
      await mkdir(moduleDir, { recursive: true });
      await writeFile(
        join(moduleDir, "GameManager.cs"),
        `public class GameManager
{
    void Start() { }
}`
      );

      mockProvider.queueResponses([
        {
          text: "I'll update the GameManager with a new method...",
          toolCalls: [
            createMockToolCall("tool-1", "file_edit", {
              path: modulePath("GameManager.cs"),
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
        { text: "Changes made.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await channel.simulateIncomingMessage("chat-edit", "Add Update method to GameManager");

      const edit = mockProvider.getToolResult("file_edit");
      expect(edit).toBeDefined();
      expect(edit?.isError).toBe(false);
      expect(edit?.content).toContain("GameManager.cs");

      const updatedContent = await readFile(join(moduleDir, "GameManager.cs"), "utf-8");
      expect(updatedContent).toContain("Update()");
      expect(updatedContent).toContain("Game loop logic");
    });
  });

  describe("DM Policy Confirmation", () => {
    it("should request confirmation before write operations", async () => {
      const { channel: manualChannel, orchestrator } = createHarness(state, { autoConfirm: false });
      await manualChannel.connect();
      manualChannel.onMessage((msg) => orchestrator.handleMessage(msg));

      mockProvider.queueResponses([
        {
          text: "I'll create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: modulePath("Test.cs"),
              content: "public class Test { }",
            }),
          ],
          stopReason: "tool_use",
        },
        { text: "Done.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await manualChannel.simulateIncomingMessage("chat-confirm", "Create Test.cs");

      expect(manualChannel.requestConfirmationSpy).toHaveBeenCalled();
      expect(manualChannel.confirmations[0]?.question).toContain("Test.cs");
    });

    it("should cancel operation when user declines confirmation", async () => {
      // autoConfirm:false IS the decline: the mock channel answers from its own
      // configuration, and a `requestConfirmationSpy.mockResolvedValue("Yes")`
      // never reached the caller — which is why the old test could only assert
      // that a confirmation object existed.
      const { channel: declineChannel, orchestrator } = createHarness(state, { autoConfirm: false });
      await declineChannel.connect();
      declineChannel.onMessage((msg) => orchestrator.handleMessage(msg));

      mockProvider.queueResponses([
        {
          text: "I'll create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: modulePath("Cancelled.cs"),
              content: "public class Cancelled { }",
            }),
          ],
          stopReason: "tool_use",
        },
        { text: "Operation was cancelled.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await declineChannel.simulateIncomingMessage("chat-decline", "Create Cancelled.cs");

      expect(declineChannel.confirmations.length).toBeGreaterThan(0);
      expect(declineChannel.confirmations[0]?.response).toBe("No");

      // THE DECLINE HELD: the tool told the model it was cancelled (not that it
      // failed — a human saying no is not an error), and no file exists.
      const write = mockProvider.getToolResult("file_write");
      expect(write).toBeDefined();
      expect(write?.content.toLowerCase()).toContain("cancelled");
      await expect(
        readFile(join(state.tempDir, MODULE_DIR, "Cancelled.cs"), "utf-8")
      ).rejects.toThrow();
    });

    it("should require confirmation for different write operations", async () => {
      const { channel: testChannel, orchestrator } = createHarness(state, { autoConfirm: true });
      await testChannel.connect();
      testChannel.onMessage((msg) => orchestrator.handleMessage(msg));

      // A one-line edit is deliberately BELOW the SMART approval threshold (50
      // changed lines), so it is never prompted for and the old test's "every
      // write operation asks" premise was false: its `lastCall` was still the
      // create's question. The claim under test is the WORDING per operation,
      // so the edit has to cross the threshold to be asked about at all.
      const bigEdit = Array.from({ length: 60 }, (_, i) => `    // line ${i}`).join("\n");

      const testCases = [
        {
          name: "file_write",
          toolCall: createMockToolCall("tool-1", "file_write", {
            path: modulePath("NewFile.cs"),
            content: "public class NewFile { }",
          }),
          description: "file create/overwrite",
        },
        {
          name: "file_edit",
          toolCall: createMockToolCall("tool-2", "file_edit", {
            path: modulePath("NewFile.cs"),
            old_string: "public class NewFile { }",
            new_string: `public class NewFile\n{\n${bigEdit}\n}`,
          }),
          description: "file edit",
        },
      ];

      for (const testCase of testCases) {
        testChannel.clear();
        testChannel.requestConfirmationSpy.mockClear();
        mockProvider.clear();

        mockProvider.queueResponses([
          { text: `Testing ${testCase.name}...`, toolCalls: [testCase.toolCall], stopReason: "tool_use" },
          { text: "Done", toolCalls: [], stopReason: "end_turn" },
        ]);

        await testChannel.simulateIncomingMessage(`chat-${testCase.name}`, `Test ${testCase.name}`);

        // The operation ran (autoConfirm answers "Yes")…
        expect(mockProvider.getToolResult(testCase.name)?.isError).toBe(false);
        // …and the question that was asked is THIS operation's question — the
        // spy is cleared each round, so a missing prompt cannot be satisfied by
        // the previous round's.
        expect(testChannel.requestConfirmationSpy).toHaveBeenCalled();
        const lastCall = testChannel.requestConfirmationSpy.mock.calls[
          testChannel.requestConfirmationSpy.mock.calls.length - 1
        ];
        expect(lastCall?.[0].question.toLowerCase()).toContain(testCase.description);
      }
    });
  });

  describe("Read-only Mode", () => {
    it("should reject write operations in read-only mode", async () => {
      const { channel: roChannel, orchestrator } = createHarness(state, { readOnly: true });
      await roChannel.connect();
      roChannel.onMessage((msg) => orchestrator.handleMessage(msg));

      mockProvider.queueResponses([
        {
          text: "I'll try to create the file...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: modulePath("ReadOnlyTest.cs"),
              content: "public class ReadOnlyTest { }",
            }),
          ],
          stopReason: "tool_use",
        },
        { text: "Write operations are disabled in read-only mode.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await roChannel.simulateIncomingMessage("chat-readonly", "Create a new file");

      // The refusal is the TOOL's own result, and no file was created.
      const write = mockProvider.getToolResult("file_write");
      expect(write).toBeDefined();
      expect(write?.isError).toBe(true);
      expect(write?.content.toLowerCase()).toContain("read-only");
      await expect(
        readFile(join(state.tempDir, MODULE_DIR, "ReadOnlyTest.cs"), "utf-8")
      ).rejects.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // The real `dotnet build`. Opt-in (`LOCAL_DOTNET_TESTS=1`) because it needs
  // the .NET SDK, which this repository does not depend on.
  //
  // The verdict asserted here is the TOOL's own line — `Exit code: N`, the
  // "### Errors"/"### Warnings" sections — which DotnetBuildTool writes itself,
  // so these assertions also hold on a machine whose SDK prints MSBuild output
  // in another language (this one prints Turkish).
  // ──────────────────────────────────────────────────────────────────────────
  describe.skipIf(!runLocalDotnetTests)("Build Result Handling (real dotnet build)", () => {
    async function writeBuildableProject(files: Record<string, string> = {}): Promise<void> {
      await mkdir(join(state.tempDir, MODULE_DIR), { recursive: true });
      await writeFile(join(state.tempDir, "TestProject.csproj"), CSPROJ);
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(state.tempDir, MODULE_DIR, name), content);
      }
    }

    function queueBuild(): void {
      mockProvider.queueResponses([
        { text: "Building...", toolCalls: [createMockToolCall("tool-1", "dotnet_build", {})], stopReason: "tool_use" },
        { text: "Build finished.", toolCalls: [], stopReason: "end_turn" },
      ]);
    }

    it("reports the build that actually ran: a valid project succeeds", async () => {
      await writeBuildableProject({ "ValidClass.cs": "public class ValidClass { }" });
      queueBuild();

      await channel.simulateIncomingMessage("chat-build-success", "Build the project");

      const build = mockProvider.getToolResult("dotnet_build");
      expect(build).toBeDefined();
      expect(build?.isError).toBe(false);
      expect(build?.content).toContain("Exit code: 0");
      expect(build?.content).not.toMatch(/### Errors/);
    });

    it("…and the same assertion FAILS for a broken project", async () => {
      // The negative twin. Without it, "Exit code: 0" could be a constant the
      // tool always prints, and a success assertion that cannot fail is not a
      // measurement.
      await writeBuildableProject({ "Broken.cs": "public class Broken { invalid syntax here }" });
      queueBuild();

      await channel.simulateIncomingMessage("chat-build-fail", "Build the broken project");

      const build = mockProvider.getToolResult("dotnet_build");
      expect(build).toBeDefined();
      expect(build?.isError).toBe(true);
      expect(build?.content).not.toContain("Exit code: 0");
      expect(build?.content).toMatch(/### Errors \(\d+\)/);
      expect(build?.content).toContain("Broken.cs");
    });

    it("a warning is a warning, not a failure", async () => {
      await writeBuildableProject({
        // CS0169: the field is never used. A real warning from a real compiler.
        "Warned.cs": "public class Warned { private int unused; }",
      });
      queueBuild();

      await channel.simulateIncomingMessage("chat-build-warnings", "Build and check warnings");

      const build = mockProvider.getToolResult("dotnet_build");
      expect(build).toBeDefined();
      expect(build?.isError).toBe(false);
      expect(build?.content).toContain("Exit code: 0");
      expect(build?.content).toMatch(/### Warnings \(\d+\)/);
      expect(build?.content).not.toMatch(/### Errors/);
    });

    it("writes three files and builds once: every file landed and the build passed", async () => {
      await writeBuildableProject();

      mockProvider.queueResponses([
        {
          text: "Creating Player...",
          toolCalls: [
            createMockToolCall("tool-1", "file_write", {
              path: modulePath("Player.cs"),
              content: "public class Player { }",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Creating Enemy...",
          toolCalls: [
            createMockToolCall("tool-2", "file_write", {
              path: modulePath("Enemy.cs"),
              content: "public class Enemy { }",
            }),
          ],
          stopReason: "tool_use",
        },
        {
          text: "Creating GameManager...",
          toolCalls: [
            createMockToolCall("tool-3", "file_write", {
              path: modulePath("GameManager.cs"),
              content: "public class GameManager { }",
            }),
          ],
          stopReason: "tool_use",
        },
        // THE REFLECTION TURN. After three consequential steps the engine
        // reflects (REFLECT_INTERVAL_AGENT_CORE = 3) and the next provider
        // response is that reflection: tool calls in it are NOT executed. A
        // sequence that puts the build here silently never builds — which is
        // what happened when this test was written against tool NAMES, since
        // the name was in the scripted list either way.
        { text: "The three classes are written; next I will build.", toolCalls: [], stopReason: "end_turn" },
        { text: "Building...", toolCalls: [createMockToolCall("tool-4", "dotnet_build", {})], stopReason: "tool_use" },
        { text: "All done.", toolCalls: [], stopReason: "end_turn" },
      ]);

      await channel.simulateIncomingMessage(
        "chat-multi",
        "Create Player, Enemy and GameManager, then build"
      );

      // Three writes that really happened…
      const writes = mockProvider.getToolResults().filter((r) => r.name === "file_write");
      expect(writes.length).toBe(3);
      expect(writes.every((w) => !w.isError)).toBe(true);
      for (const name of ["Player.cs", "Enemy.cs", "GameManager.cs"]) {
        const onDisk = await readFile(join(state.tempDir, MODULE_DIR, name), "utf-8");
        expect(onDisk).toContain("class");
      }

      // …and one build, whose verdict is the compiler's.
      const builds = mockProvider.getToolResults().filter((r) => r.name === "dotnet_build");
      expect(builds.length).toBe(1);
      expect(builds[0]?.isError).toBe(false);
      expect(builds[0]?.content).toContain("Exit code: 0");
    });
  });
});

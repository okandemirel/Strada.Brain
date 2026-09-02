import { describe, expect, it } from "vitest";
import { SelfVerification } from "./self-verification.js";
import type { WorkerRunResult } from "../supervisor/supervisor-types.js";

/** A completed delegation that touched the given files and reports no issues. */
function completedWorker(touchedFiles: readonly string[]): WorkerRunResult {
  return {
    status: "completed",
    finalSummary: "done",
    visibleResponse: "done",
    provider: "test",
    catalogVersion: "v",
    assignmentVersion: 1,
    touchedFiles,
    toolTrace: [],
    verificationResults: [],
    reviewFindings: [],
    artifacts: [],
  };
}

describe("SelfVerification", () => {
  it("accepts verification-oriented shell commands as a clean verification signal", () => {
    // Assets/Thing.cs, not Assets/Test.cs: a filename ending in Test.cs marks a
    // test file, and those are deliberately not settled by a typecheck.
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Thing.cs" }, {
      toolCallId: "tc-write",
      content: "written",
      isError: false,
    });
    expect(verifier.needsVerification()).toBe(true);

    verifier.track("shell_exec", { command: "npm run typecheck:src" }, {
      toolCallId: "tc-verify",
      content: "$ npm run typecheck:src\nExit code: 0",
      isError: false,
    });

    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getState().pendingFiles.size).toBe(0);
    expect(verifier.getState().touchedFiles.has("Assets/Thing.cs")).toBe(true);
    expect(verifier.getState().lastVerificationAt).not.toBeNull();
  });

  it("treats generic Unity verification tools as valid clean signals", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Gameplay/TestSystem.cs" }, {
      toolCallId: "tc-write",
      content: "written",
      isError: false,
    });
    expect(verifier.needsVerification()).toBe(true);

    verifier.track("unity_editmode_test", {}, {
      toolCallId: "tc-unity-verify",
      content: "All tests passed",
      isError: false,
    });

    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getState().pendingFiles.size).toBe(0);
    expect(verifier.getState().touchedFiles.has("Assets/Gameplay/TestSystem.cs")).toBe(true);
  });

  it("a failing test run keeps the gate open after a clean compile (and a red body beats a green flag)", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "Assets/Gameplay/Board.cs" }, {
      toolCallId: "tc-w", content: "written", isError: false,
    });
    // Clean headless compile clears the compilable-changes gate…
    verifier.track("unity_verify_change", {}, {
      toolCallId: "tc-c", content: "compile green", isError: false,
    });
    expect(verifier.needsVerification()).toBe(false);

    // …then a PlayMode run whose BODY reports failures (success-shaped flag)
    // must reopen the gate: measured class — a run declared DONE over a
    // failing suite because nothing tracked the red result.
    verifier.track("unity_playmode_verify", {}, {
      toolCallId: "tc-t", content: "PlayMode verification FAILED: 5 of 95 tests failed", isError: false,
    });
    expect(verifier.needsVerification()).toBe(true);
    expect(verifier.getPrompt()).toContain("[TESTS FAILING]");

    // A later green run closes it.
    verifier.track("unity_playmode_verify", {}, {
      toolCallId: "tc-t2", content: "All 95 tests passed", isError: false,
    });
    expect(verifier.needsVerification()).toBe(false);
  });

  it("flags a redundant re-compile when nothing changed since the last clean verify", () => {
    const verifier = new SelfVerification();
    verifier.track("file_write", { path: "Assets/Modules/BoardModule/Board.cs" }, {
      toolCallId: "w", content: "written", isError: false,
    });
    verifier.track("unity_verify_change", {}, {
      toolCallId: "v", content: "compile green", isError: false,
    });
    // Nothing touched since: another compile would burn minutes for an
    // identical answer.
    expect(verifier.isRedundantVerification()).toBe(true);

    verifier.track("file_edit", { path: "Assets/Modules/BoardModule/Board.cs" }, {
      toolCallId: "w2", content: "edited", isError: false,
    });
    expect(verifier.isRedundantVerification()).toBe(false);
  });

  it("tracks nested batch_execute mutations and verification results", () => {
    const verifier = new SelfVerification();

    verifier.track(
      "batch_execute",
      {
        operations: [
          { tool: "file_write", input: { path: "Assets/Gameplay/BatchedSystem.cs" } },
          { tool: "unity_editmode_test", input: {} },
        ],
      },
      {
        toolCallId: "tc-batch",
        content: JSON.stringify({
          results: [
            { tool: "file_write", success: true, content: "written" },
            { tool: "unity_editmode_test", success: true, content: "all green" },
          ],
        }),
        isError: false,
      },
    );

    expect(verifier.needsVerification()).toBe(false);
    expect(verifier.getState().pendingFiles.size).toBe(0);
    expect(verifier.getState().touchedFiles.has("Assets/Gameplay/BatchedSystem.cs")).toBe(true);
  });

  it("retains touched files across clean verification for completion review", () => {
    const verifier = new SelfVerification();

    verifier.track("file_write", { path: "src/runtime/reviewer.ts" }, {
      toolCallId: "tc-write",
      content: "written",
      isError: false,
    });
    verifier.track("shell_exec", { command: "npm run lint:src" }, {
      toolCallId: "tc-lint",
      content: "$ npm run lint:src\nExit code: 0",
      isError: false,
    });

    const state = verifier.getState();
    expect(state.pendingFiles.size).toBe(0);
    expect(state.touchedFiles.has("src/runtime/reviewer.ts")).toBe(true);
    expect(verifier.hasTouchedFiles()).toBe(true);
  });

  /**
   * Audited 2026-09-02: VERIFICATION_SHELL_COMMAND_RE was an unanchored word
   * search over the whole line, so `cp Assets/Scripts/Test.cs …`, `mkdir -p
   * build` and `cat GAME_DESIGN.md | grep test` each cleared the compile gate,
   * emptied pendingFiles and published lastBuildOk=true — a file copy recorded
   * as a clean build. A shell command verifies when the PROGRAM it invokes is
   * a verifier, checked per segment of a chain.
   */
  describe("a shell command is a verification only when it invokes a verifier", () => {
    function fiveSourceFiles(): SelfVerification {
      const verifier = new SelfVerification();
      for (let i = 0; i < 5; i++) {
        verifier.track("file_write", { path: `Assets/Scripts/Thing${i}.cs` }, {
          toolCallId: `w${i}`, content: "written", isError: false,
        });
      }
      expect(verifier.needsVerification()).toBe(true);
      return verifier;
    }

    it.each([
      "cp Assets/Scripts/Test.cs Assets/Scripts/Test2.cs",
      "mkdir -p build",
      "cat GAME_DESIGN.md | grep test",
      "git commit -m 'add board test'",
      "rm -rf Library/Bee/build",
      "grep -rn Test Assets/Scripts",
    ])("does not clear the gate for: %s", (command) => {
      const verifier = fiveSourceFiles();
      verifier.track("shell_exec", { command }, { toolCallId: "s", content: "", isError: false });

      expect(verifier.needsVerification()).toBe(true);
      expect(verifier.getState().lastBuildOk).toBeNull();
      expect(verifier.getState().pendingFiles.size).toBe(5);
    });

    it.each([
      "npm run typecheck:src",
      "cd Assets && npx tsc --noEmit",
      "dotnet build src/Core/Core.csproj -v q",
      "CI=1 npx vitest run src/agents",
      "make test",
      "npm test",
    ])("clears the gate for: %s", (command) => {
      const verifier = fiveSourceFiles();
      verifier.track("shell_exec", { command }, { toolCallId: "s", content: "Exit code: 0", isError: false });

      expect(verifier.needsVerification()).toBe(false);
      expect(verifier.getState().lastBuildOk).toBe(true);
    });
  });

  /**
   * Audited 2026-09-02: lastBuildOk was assigned only by a verification, so
   * after one clean compile it stayed `true` through every later compilable
   * change — needsVerification() (hasCompilableChanges && lastBuildOk !== true)
   * read false, the build check reported "clean", and never-compiled files were
   * approved. Reached by a delegated worker's touchedFiles and by a plain
   * file_write alike.
   */
  describe("a clean compile does not outlive the next compilable change", () => {
    function cleanlyCompiled(): SelfVerification {
      const verifier = new SelfVerification();
      verifier.track("file_write", { path: "Assets/Modules/BoardModule/A.cs" }, {
        toolCallId: "w", content: "written", isError: false,
      });
      verifier.track("unity_verify_change", {}, {
        toolCallId: "v", content: "compile green", isError: false,
      });
      expect(verifier.needsVerification()).toBe(false);
      return verifier;
    }

    it("re-arms the gate for files a delegated worker wrote", () => {
      const verifier = cleanlyCompiled();
      const touchedFiles = Array.from({ length: 12 }, (_, i) => `Assets/Modules/BoardModule/W${i}.cs`);
      verifier.ingestWorkerResult(completedWorker(touchedFiles));

      expect(verifier.needsVerification()).toBe(true);
      expect(verifier.getState().lastBuildOk).not.toBe(true);
      // The files are named, not just counted: the prompt must say what is unverified.
      expect(verifier.getState().pendingFiles.has(touchedFiles[0]!)).toBe(true);
      expect(verifier.getPrompt()).toContain("W0.cs");
    });

    it("re-arms the gate for a direct edit", () => {
      const verifier = cleanlyCompiled();
      verifier.track("file_write", { path: "Assets/Modules/BoardModule/B.cs" }, {
        toolCallId: "w2", content: "written", isError: false,
      });

      expect(verifier.needsVerification()).toBe(true);
      expect(verifier.getState().lastBuildOk).not.toBe(true);
    });

    it("leaves a non-compilable delegated change alone", () => {
      const verifier = cleanlyCompiled();
      verifier.ingestWorkerResult(completedWorker(["docs/notes.md"]));

      expect(verifier.needsVerification()).toBe(false);
    });
  });
});

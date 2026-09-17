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

  it("carries no redundant-verification predicate that nothing consumes", () => {
    // Audited 2026-09-02: isRedundantVerification() claimed "Consumers surface
    // this as guidance" and had none — its only reads were in this file — so
    // the measured 11-compiles-in-2h waste read as mitigated while nothing
    // mitigated it. Wiring it as-is would have been a hazard (only
    // .cs/.csproj/... mutations set its flag, so an .asmdef or .shader edit
    // would read as "a recompile is guaranteed identical"). It was deleted;
    // this pins the deletion so the false claim cannot quietly return.
    const verifier = new SelfVerification();

    expect((verifier as unknown as Record<string, unknown>)["isRedundantVerification"]).toBeUndefined();
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
   * Audited 2026-09-02: the compile gate gave up after ten asks, silently —
   * the tenth text was byte-identical to the first — and once needsVerification()
   * dropped the gate, the build check reported "clean" over files that were
   * never compiled. The sibling gates say "this is the last time this is asked";
   * this one must too, and the exhausted state must stay visible.
   */
  describe("the compile gate's cap is not silent, and exhausting it is not a clean build", () => {
    it("says on the tenth ask that it is the last, and keeps the debt visible afterwards", () => {
      const verifier = new SelfVerification();
      verifier.track("file_write", { path: "Assets/Game/Board.cs" }, {
        toolCallId: "w", content: "written", isError: false,
      });

      const asks: string[] = [];
      while (verifier.needsVerification()) asks.push(verifier.getPrompt());

      expect(asks).toHaveLength(10);
      expect(asks[8]).not.toContain("last time");
      expect(asks[9]).toContain("last time");
      expect(asks[9]).toMatch(/report .*unverified/u);
      expect(verifier.buildGateExhausted()).toBe(true);
      expect(verifier.getState().buildGateExhausted).toBe(true);
      expect(verifier.getState().pendingFiles.has("Assets/Game/Board.cs")).toBe(true);
    });

    it("is not exhausted while the gate is still being asked, nor after a clean pass", () => {
      const verifier = new SelfVerification();
      verifier.track("file_write", { path: "Assets/Game/Board.cs" }, {
        toolCallId: "w", content: "written", isError: false,
      });
      verifier.getPrompt();
      expect(verifier.buildGateExhausted()).toBe(false);

      verifier.track("unity_verify_change", {}, {
        toolCallId: "v", content: "compile green", isError: false,
      });
      expect(verifier.buildGateExhausted()).toBe(false);
    });
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

  /**
   * Codex round AE#3, reproduced: a write to Assets/Rules.cs followed by an
   * inspection, an empty result, a compile still in flight, a usage dump or a
   * build that never ran all produced lastBuildOk: true, an empty pending
   * list and needsVerification(): false.
   */
  /**
   * Codex wave 0-A review 2026-09-17 #1, reproduced against a real
   * `npx tsc --noEmit` on a project with a TS2322: `ok_exit_codes: [0, 2]`
   * made the exit-2 result isError: false, and lastBuildOk went true with an
   * "error TS2322" body. Accepting an exit code keeps a predicate off the
   * breaker; it does not make a verifier pass.
   */
  describe("an accepted non-zero exit is not a passing proof (Codex 2026-09-17 #1)", () => {
    const wroteCs = (): SelfVerification => {
      const verifier = new SelfVerification();
      verifier.track("file_write", { path: "Assets/Bad.cs" }, { toolCallId: "w", content: "written", isError: false });
      expect(verifier.needsVerification()).toBe(true);
      return verifier;
    };

    it("tsc exit 2 with ok_exit_codes [0,2] keeps the compile debt (metadata carries the code)", () => {
      const verifier = wroteCs();
      verifier.track("shell_exec", { command: "npx tsc --noEmit", ok_exit_codes: [0, 2] }, {
        toolCallId: "v",
        content: "$ npx tsc --noEmit\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nExit code: 2",
        isError: false,
        metadata: { exitCode: 2 },
      });
      expect(verifier.getState().lastBuildOk).toBe(false);
      expect(verifier.needsVerification()).toBe(true);
    });

    it("a batch child without metadata is judged by the tool's own footer line (Codex on 7cb9d8a3 #1)", () => {
      // The footer the formatter writes: `Exit code: N | Duration: Nms`,
      // before stdout. A bare "Exit code: 2" line matched; the real one did not.
      const verifier = wroteCs();
      verifier.track("shell_exec", { command: "npx tsc --noEmit", ok_exit_codes: [0, 2] }, {
        toolCallId: "v",
        content: "$ npx tsc --noEmit\nExit code: 2 | Duration: 17ms\n\n--- stdout ---\nerror TS2322: nope",
        isError: false,
      });
      expect(verifier.getState().lastBuildOk).toBe(false);
      // …and a program that PRINTS "Exit code: 1" under a real exit 0 has passed.
      const echoed = wroteCs();
      echoed.track("shell_exec", { command: "npx tsc --noEmit" }, {
        toolCallId: "v2",
        content: "$ npx tsc --noEmit\nExit code: 0 | Duration: 17ms\n\n--- stdout ---\nnote: a previous run said Exit code: 1",
        isError: false,
      });
      expect(echoed.getState().lastBuildOk).toBe(true);
      // A string code in the metadata is still a code; no code at all is not a zero.
      const stringCode = wroteCs();
      stringCode.track("shell_exec", { command: "npx tsc --noEmit", ok_exit_codes: [0, 2] }, { toolCallId: "v3", content: "$ npx tsc --noEmit\nsome output", isError: false, metadata: { exitCode: "2" } });
      expect(stringCode.getState().lastBuildOk).toBe(false);
      const silent = wroteCs();
      silent.track("shell_exec", { command: "npx tsc --noEmit" }, { toolCallId: "v4", content: "$ npx tsc --noEmit\nsome output, no footer", isError: false });
      expect(silent.getState().lastBuildOk).not.toBe(true);
    });

    it("a test run that exited 1 under ok_exit_codes [0,1] leaves the test gate open", () => {
      const verifier = wroteCs();
      verifier.track("file_write", { path: "Assets/Tests/BadTests.cs" }, { toolCallId: "w2", content: "written", isError: false });
      verifier.track("shell_exec", { command: "npx vitest run", ok_exit_codes: [0, 1] }, {
        toolCallId: "t",
        content: "$ npx vitest run\n Tests  1 failed | 2 passed (3)\nExit code: 1",
        isError: false,
        metadata: { exitCode: 1 },
      });
      expect(verifier.getState().lastBuildOk).toBe(false);
      expect(verifier.needsVerification()).toBe(true);
    });

    it("guard: an accepted exit 0 still settles the debt", () => {
      const verifier = wroteCs();
      verifier.track("shell_exec", { command: "npx tsc --noEmit", ok_exit_codes: [0, 2] }, {
        toolCallId: "v",
        content: "$ npx tsc --noEmit\nExit code: 0",
        isError: false,
        metadata: { exitCode: 0 },
      });
      expect(verifier.getState().lastBuildOk).toBe(true);
      expect(verifier.needsVerification()).toBe(false);
    });
  });

  describe("an inspection is not a verification (Codex 2026-09-12 AE#3)", () => {
    const wrote = (): SelfVerification => {
      const verifier = new SelfVerification();
      verifier.track("file_write", { path: "Assets/Rules.cs" }, { toolCallId: "w", content: "written", isError: false });
      expect(verifier.needsVerification()).toBe(true);
      return verifier;
    };

    it("keeps the debt when a tool only ANSWERED A QUESTION", () => {
      for (const [tool, body] of [
        ["csharp_symbol_search", "No matches"],
        ["unity_console_read", "[]"],
        ["unity_console_analyze", "no errors in the console"],
      ] as const) {
        const verifier = wrote();
        verifier.track(tool, {}, { toolCallId: "v", content: body, isError: false });
        expect(verifier.needsVerification(), tool).toBe(true);
        expect(verifier.getState().pendingFiles.has("Assets/Rules.cs"), tool).toBe(true);
      }
    });

    it("keeps the debt when the verifier settled nothing", () => {
      for (const body of [
        "{}",
        '{"success":false,"isCompiling":true}',
        "Usage: dotnet build [options]\nDescription:\n  Builds a project",
      ]) {
        const verifier = wrote();
        verifier.track("unity_compile_status", {}, { toolCallId: "v", content: body, isError: false });
        expect(verifier.needsVerification(), body).toBe(true);
        expect(verifier.getState().lastBuildOk, body).toBeNull();
      }
    });

    it("does not accept a build the command SKIPPED", () => {
      // `true || dotnet build` exits 0 having built nothing.
      const verifier = wrote();
      verifier.track("shell_exec", { command: "true || dotnet build" }, { toolCallId: "v", content: "$ true || dotnet build\nExit code: 0", isError: false });
      expect(verifier.needsVerification()).toBe(true);
      // …while a real build still settles it, silent success included.
      const ok = wrote();
      ok.track("shell_exec", { command: "dotnet build || echo failed" }, { toolCallId: "v", content: "$ dotnet build\nExit code: 0", isError: false });
      expect(ok.needsVerification()).toBe(false);
    });

    it("keeps the debt for the shapes round AF found (Codex 2026-09-13 AF#3)", () => {
      // Each of these reproduced lastBuildOk:true with an empty pending list.
      for (const [body, why] of [
        ['{"status":"unavailable"}', "the tool could not answer"],
        // One reason at a time: two failure signals in one fixture hide each
        // other when either is removed.
        ['{"success":false}', "the body says it failed"],
        ['{"compileIssueCount":3}', "the body counts compile issues"],
        ['{"detail":"Build failed"}', "the body says the build failed"],
      ] as const) {
        const verifier = wrote();
        verifier.track("unity_compile_status", {}, { toolCallId: "v", content: body, isError: false });
        expect(verifier.needsVerification(), why).toBe(true);
      }
      // A build the shell never reached is not a build…
      const skipped = wrote();
      skipped.track("shell_exec", { command: "false && dotnet build; true" }, { toolCallId: "v", content: "$ …\nExit code: 0", isError: false });
      expect(skipped.needsVerification()).toBe(true);
      // …while a build that DID run behind a `||` and printed its verdict is.
      const ranAnyway = wrote();
      ranAnyway.track("shell_exec", { command: "false || dotnet build" }, {
        toolCallId: "v",
        content: "$ false || dotnet build\nExit code: 0\n\n--- stdout ---\nBuild succeeded.\n0 errors",
        isError: false,
      });
      expect(ranAnyway.needsVerification()).toBe(false);
      // …and the same command with nothing to show for itself is not.
      const silentOr = wrote();
      silentOr.track("shell_exec", { command: "false || dotnet build" }, { toolCallId: "v", content: "$ …\nExit code: 0", isError: false });
      expect(silentOr.needsVerification()).toBe(true);
    });

    it("reads a BATCH child's own output, not the envelope's (Codex 2026-09-13 AF#3)", () => {
      const verifier = wrote();
      verifier.track(
        "batch_execute",
        { operations: [{ tool: "unity_compile_status", input: {} }] },
        {
          toolCallId: "b",
          content: JSON.stringify({ results: [{ success: true, content: "{}" }] }),
          isError: false,
        },
      );
      expect(verifier.needsVerification()).toBe(true);
    });

    it("still settles on a conclusive answer", () => {
      const verifier = wrote();
      verifier.track("unity_compile_status", {}, { toolCallId: "v", content: '{"isCompiling":false,"compileIssueCount":0}', isError: false });
      expect(verifier.needsVerification()).toBe(false);
      expect(verifier.getState().lastBuildOk).toBe(true);
    });
  });
});

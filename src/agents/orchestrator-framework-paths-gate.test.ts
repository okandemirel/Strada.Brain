/**
 * frameworkPathsOnly as a WALL, not a tracker: compilable game code must land
 * in the Strada module layout. Enforced at the single write-review choke
 * point, so direct writes and batch_execute operations are judged identically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";

type Review = { approved: boolean; reason?: string };

const review = (
  orch: Orchestrator,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Review> =>
  Promise.resolve(
    (
      orch as unknown as {
        reviewSelfManagedWriteOperation: (
          chatId: string,
          toolName: string,
          input: Record<string, unknown>,
          mode: unknown,
          options: unknown,
        ) => Promise<Review> | Review;
      }
    ).reviewSelfManagedWriteOperation("chat1", toolName, input, "interactive", {}),
  );

function tool(name: string, mutates: boolean) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: !mutates },
    execute: vi.fn().mockResolvedValue({ content: "ok" }),
  };
}

function makeOrch(conformanceFrameworkPathsOnly: boolean | undefined) {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [tool("file_write", true), tool("file_edit", true), tool("file_delete", true)] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: true,
    conformanceFrameworkPathsOnly,
  } as never);
}

let orch: Orchestrator;
beforeEach(() => {
  orch = makeOrch(true);
});
afterEach(() => vi.clearAllMocks());

describe("framework-paths write wall", () => {
  it("blocks loose compilable game code under Assets/", async () => {
    const r = await review(orch, "file_write", {
      path: "Assets/Scripts/RandomManager.cs",
      content: "class X {}",
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toContain("Assets/Modules/");
  });

  it("allows the Strada module layout, editor tooling, tests and plugins", async () => {
    for (const path of [
      "Assets/Modules/BoardModule/Scripts/BoardSystem.cs",
      "Assets/Editor/MainScenePresentationInstaller.cs",
      "Assets/Tests/PlayMode/BoardTests.cs",
      "Assets/Plugins/ThirdParty/Lib.cs",
    ]) {
      const r = await review(orch, "file_write", { path, content: "class X {}" });
      expect(r.approved, path).toBe(true);
    }
  });

  it("does not touch non-code assets or non-Assets paths", async () => {
    for (const path of [
      "Assets/Settings/PresentationPrefabConfig.asset",
      "Assets/Art/Generated/pig.png",
      "docs/notes.md",
      "src/whatever.cs",
    ]) {
      const r = await review(orch, "file_write", { path, content: "x" });
      expect(r.approved, path).toBe(true);
    }
  });

  // audited 2026-09-02: file_rename was a separate case that checked only
  // that both paths were present, so write-to-module + rename-out (or a bare
  // rename from anywhere) landed loose game code the wall exists to refuse.
  describe("file_rename is judged by its destination", () => {
    it("refuses a rename that lands compilable code outside the module layout", async () => {
      const r = await review(orch, "file_rename", {
        old_path: "Assets/Modules/TmpModule/RandomManager.cs",
        new_path: "Assets/Scripts/RandomManager.cs",
      });
      expect(r.approved).toBe(false);
      expect(r.reason).toContain("Assets/Modules/");
    });

    it("refuses the same rename inside a batch", async () => {
      const r = await review(orch, "batch_execute", {
        operations: [
          { tool: "file_write", input: { path: "Assets/Modules/TmpModule/A.cs", content: "class A {}" } },
          { tool: "file_rename", input: { old_path: "Assets/Modules/TmpModule/A.cs", new_path: "Assets/Scripts/A.cs" } },
        ],
      });
      expect(r.approved).toBe(false);
      expect(r.reason).toMatch(/batched file_rename was refused/);
    });

    it("allows a rename that stays within the module layout or moves non-code", async () => {
      for (const [oldPath, newPath] of [
        ["Assets/Scripts/Legacy.cs", "Assets/Modules/LegacyModule/Legacy.cs"],
        ["Assets/Art/a.png", "Assets/Art/Generated/a.png"],
        ["Assets/Scripts/Old.cs", "Assets/Editor/Old.cs"],
      ]) {
        const r = await review(orch, "file_rename", { old_path: oldPath, new_path: newPath });
        expect(r.approved, `${oldPath} -> ${newPath}`).toBe(true);
      }
    });
  });

  it("deletes are exempt (cleanup of legacy loose scripts stays possible)", async () => {
    const r = await review(orch, "file_delete", { path: "Assets/Scripts/Legacy.cs" });
    expect(r.approved).toBe(true);
  });

  it("explicit opt-out restores the old permissive behavior", async () => {
    const permissive = makeOrch(false);
    const r = await review(permissive, "file_write", {
      path: "Assets/Scripts/RandomManager.cs",
      content: "class X {}",
    });
    expect(r.approved).toBe(true);
  });
});

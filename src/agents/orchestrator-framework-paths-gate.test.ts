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
  options: Record<string, unknown> = {},
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
    ).reviewSelfManagedWriteOperation("chat1", toolName, input, "interactive", options),
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

function makeOrch(conformanceFrameworkPathsOnly: boolean | undefined, projectPath = "/tmp/test-project") {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    // A batch reaches only what the run holds, so file_rename is here for the
    // batched rename below to be judged by the wall at all.
    tools: [tool("file_write", true), tool("file_edit", true), tool("file_delete", true), tool("file_rename", true)] as never,
    channel: createMockChannel() as never,
    projectPath,
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
      "Assets/Modules/KilnModule/Scripts/KilnSystem.cs",
      "Assets/Editor/KilnMenuItems.cs",
      "Assets/Tests/PlayMode/KilnTests.cs",
      "Assets/Plugins/ThirdParty/Lib.cs",
    ]) {
      const r = await review(orch, "file_write", { path, content: "class X {}" });
      expect(r.approved, path).toBe(true);
    }
  });

  it("does not touch non-code assets or non-Assets paths", async () => {
    for (const path of [
      "Assets/Settings/GlazePaletteConfig.asset",
      "Assets/Art/Generated/saucer.png",
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

describe("the wall names the module twin", () => {
  // Measured 2026-09-07: repeated refusals on a loose script that duplicated
  // a module copy, none naming it.
  it("points at Assets/Modules/…/Same.cs and at file_delete for the loose copy", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "twin-"));
    try {
      mkdirSync(join(root, "Assets", "Modules", "GlazeModule", "Scripts"), { recursive: true });
      writeFileSync(join(root, "Assets", "Modules", "GlazeModule", "Scripts", "GlazeRecipe.cs"), "module copy");
      const o = new Orchestrator({
        providerManager: {
          getProvider: () => createMockProvider(),
          getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as never,
        tools: [tool("file_edit", true)] as never,
        channel: createMockChannel() as never,
        projectPath: root,
        readOnly: false,
        requireConfirmation: true,
        conformanceFrameworkPathsOnly: true,
      } as never);
      const r = await review(o, "file_edit", { path: "Assets/Scripts/GlazeRecipe.cs", old_string: "a", new_string: "b" });
      expect(r.approved).toBe(false);
      expect(r.reason).toContain("loose duplicate of Assets/Modules/GlazeModule/Scripts/GlazeRecipe.cs");
      expect(r.reason).toContain("file_delete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The wall judges the write against the lease, so the twin has to be looked
  // up there too: a module copy the run created in its lease is not in the
  // checkout yet, and the refusal fell back to "create the owning module".
  it("names a twin that exists only in the run's lease", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const checkout = mkdtempSync(join(tmpdir(), "twin-checkout-"));
    const lease = mkdtempSync(join(tmpdir(), "twin-lease-"));
    try {
      writeFileSync(join(lease, ".strada-lease-owner.json"), JSON.stringify({ projectRoot: checkout }));
      mkdirSync(join(lease, "Assets", "Modules", "GlazeModule", "Scripts"), { recursive: true });
      writeFileSync(join(lease, "Assets", "Modules", "GlazeModule", "Scripts", "GlazeRecipe.cs"), "module copy");
      const o = makeOrch(true, checkout);
      const r = await review(
        o,
        "file_edit",
        { path: "Assets/Scripts/GlazeRecipe.cs", old_string: "a", new_string: "b" },
        { workspaceLease: { path: lease } },
      );
      expect(r.approved).toBe(false);
      expect(r.reason).toContain("loose duplicate of Assets/Modules/GlazeModule/Scripts/GlazeRecipe.cs");
    } finally {
      rmSync(checkout, { recursive: true, force: true });
      rmSync(lease, { recursive: true, force: true });
    }
  });
});

// The write tools resolve the path against the run's root and check only that
// it stays inside (path-guard.ts), so every spelling of Assets/Scripts/Foo.cs
// writes the same file. The wall matched the spelling: an absolute path, or one
// that passed through Assets/Modules/.. on its way, landed a loose script.
describe("the wall judges where the write lands, not how the path is spelled", () => {
  it("refuses absolute, dot-segment and backslash spellings of a loose script", async () => {
    for (const path of [
      "/tmp/test-project/Assets/Scripts/Foo.cs",
      "Assets/Modules/../Scripts/Foo.cs",
      "Assets\\Modules\\..\\Scripts\\Foo.cs",
      "./Assets/./Scripts/Foo.cs",
      "Assets/Editor/../../Assets/Scripts/Foo.cs",
    ]) {
      const r = await review(orch, "file_write", { path, content: "class X {}" });
      expect(r.approved, path).toBe(false);
      expect(r.reason, path).toContain("Assets/Modules/");
    }
  });

  it("judges a rename destination and a batched write by the same resolved path", async () => {
    const rename = await review(orch, "file_rename", {
      old_path: "Assets/Modules/TmpModule/A.cs",
      new_path: "/tmp/test-project/Assets/Scripts/A.cs",
    });
    expect(rename.approved).toBe(false);
    const batch = await review(orch, "batch_execute", {
      operations: [{ tool: "file_write", input: { path: "/tmp/test-project/Assets/Scripts/B.cs", content: "class B {}" } }],
    });
    expect(batch.approved).toBe(false);
    expect(batch.reason).toMatch(/batched file_write was refused/);
  });

  it("still allows the module layout and paths outside Assets/ when spelled absolutely", async () => {
    for (const path of [
      "/tmp/test-project/Assets/Modules/KilnModule/Scripts/Kiln.cs",
      "/tmp/test-project/Assets/Scripts/../Modules/KilnModule/Kiln.cs",
      "/tmp/test-project/src/whatever.cs",
    ]) {
      const r = await review(orch, "file_write", { path, content: "class X {}" });
      expect(r.approved, path).toBe(true);
    }
  });

  it("resolves against the run's lease, where the real checkout's path is redirected", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const checkout = mkdtempSync(join(tmpdir(), "fpw-checkout-"));
    const lease = mkdtempSync(join(tmpdir(), "fpw-lease-"));
    try {
      writeFileSync(join(lease, ".strada-lease-owner.json"), JSON.stringify({ projectRoot: checkout }));
      const o = makeOrch(true, checkout);
      const options = { workspaceLease: { path: lease } };
      for (const path of [join(lease, "Assets", "Scripts", "Foo.cs"), join(checkout, "Assets", "Scripts", "Foo.cs")]) {
        const r = await review(o, "file_write", { path, content: "class X {}" }, options);
        expect(r.approved, path).toBe(false);
      }
      const ok = await review(o, "file_write", { path: join(lease, "Assets", "Modules", "M", "Foo.cs"), content: "x" }, options);
      expect(ok.approved).toBe(true);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
      rmSync(lease, { recursive: true, force: true });
    }
  });

  it("matches the root through a symlink in either direction (/var vs /private/var)", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "fpw-link-"));
    const real = join(base, "real");
    const link = join(base, "link");
    try {
      mkdirSync(join(real, "Assets"), { recursive: true });
      symlinkSync(real, link, "dir");
      for (const [root, other] of [[link, real], [real, link]] as const) {
        const o = makeOrch(true, root);
        const path = join(other, "Assets", "Scripts", "Foo.cs");
        const r = await review(o, "file_write", { path, content: "class X {}" });
        expect(r.approved, `${path} against root ${root}`).toBe(false);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

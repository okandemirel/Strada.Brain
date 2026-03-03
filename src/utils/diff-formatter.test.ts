import { describe, it, expect } from "vitest";
import {
  formatDiffForTelegram,
  formatBatchDiffForTelegram,
  formatDiffForWhatsApp,
  formatBatchDiffForWhatsApp,
  formatDiffForCLI,
  formatBatchDiffForCLI,
  formatCompactSummary,
  formatDiffForChannel,
  formatBatchDiffForChannel,
} from "./diff-formatter.js";
import type { FileDiff, BatchDiff } from "./diff-generator.js";

describe("diff-formatter", () => {
  const mockFileDiff: FileDiff = {
    oldPath: "src/test.ts",
    newPath: "src/test.ts",
    diff: `--- src/test.ts
+++ src/test.ts
@@ -1,3 +1,3 @@
 function test() {
-  return 1;
+  return 2;
 }`,
    stats: { additions: 1, deletions: 1, modifications: 1, totalChanges: 2, hunks: 1 },
    isNew: false,
    isDeleted: false,
    isRename: false,
  };

  const mockNewFileDiff: FileDiff = {
    oldPath: "/dev/null",
    newPath: "src/new.ts",
    diff: `--- /dev/null
+++ src/new.ts
@@ -0,0 +1,3 @@
+function newFunc() {
+  return 42;
+}`,
    stats: { additions: 3, deletions: 0, modifications: 0, totalChanges: 3, hunks: 1 },
    isNew: true,
    isDeleted: false,
    isRename: false,
  };

  const mockDeletedFileDiff: FileDiff = {
    oldPath: "src/old.ts",
    newPath: "/dev/null",
    diff: `--- src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-function oldFunc() {
-  return 0;
-}`,
    stats: { additions: 0, deletions: 3, modifications: 0, totalChanges: 3, hunks: 1 },
    isNew: false,
    isDeleted: true,
    isRename: false,
  };

  const mockRenameDiff: FileDiff = {
    oldPath: "src/old.ts",
    newPath: "src/new.ts",
    diff: "--- src/old.ts\n+++ src/new.ts\n@@ -1,1 +1,1 @@\n rename from src/old.ts\n rename to src/new.ts",
    stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 },
    isNew: false,
    isDeleted: false,
    isRename: true,
  };

  const mockBatchDiff: BatchDiff = {
    files: [mockFileDiff, mockNewFileDiff],
    totalStats: { additions: 4, deletions: 1, modifications: 1, totalChanges: 5, hunks: 2 },
    summary: "1 changed, 1 added (+4/-1)",
  };

  describe("formatDiffForTelegram", () => {
    it("should format file diff with markdown", () => {
      const result = formatDiffForTelegram(mockFileDiff);

      expect(result).toContain("📄 *src/test.ts*");
      expect(result).toContain("```diff");
      expect(result).toContain("+  return 2");
      expect(result).toContain("-  return 1");
    });

    it("should mark new files", () => {
      const result = formatDiffForTelegram(mockNewFileDiff);

      expect(result).toContain("_(new file)_");
      expect(result).toContain("+3");
    });

    it("should mark deleted files", () => {
      const result = formatDiffForTelegram(mockDeletedFileDiff);

      expect(result).toContain("_(deleted)_");
      expect(result).toContain("-3");
    });

    it("should mark renamed files", () => {
      const result = formatDiffForTelegram(mockRenameDiff);

      expect(result).toContain("_(renamed from");
      expect(result).not.toContain("```diff"); // No content diff for pure rename
    });

    it("should escape markdown special characters", () => {
      const diffWithSpecialChars: FileDiff = {
        ...mockFileDiff,
        newPath: "src/test_[special].ts",
      };

      const result = formatDiffForTelegram(diffWithSpecialChars);

      expect(result).toContain("\\[");
      expect(result).toContain("\\]");
    });

    it("should truncate long diffs", () => {
      const result = formatDiffForTelegram(mockFileDiff, { maxLines: 2 });

      expect(result).toContain("truncated");
    });
  });

  describe("formatBatchDiffForTelegram", () => {
    it("should format batch with summary header", () => {
      const result = formatBatchDiffForTelegram(mockBatchDiff);

      expect(result).toContain("*📋 Changes Summary*");
      expect(result).toContain("2 files");
      expect(result).toContain("📄 *src/test.ts*");
      expect(result).toContain("📄 *src/new.ts*");
    });

    it("should truncate when exceeding max length", () => {
      const largeBatch: BatchDiff = {
        files: Array.from({ length: 20 }, (_, i) => ({
          ...mockFileDiff,
          newPath: `src/file${i}.ts`,
        })),
        totalStats: mockBatchDiff.totalStats,
        summary: "20 files changed",
      };

      const result = formatBatchDiffForTelegram(largeBatch, { maxLength: 1000 });

      expect(result).toContain("and");
      expect(result).toContain("more files");
    });
  });

  describe("formatDiffForWhatsApp", () => {
    it("should format with limited markdown", () => {
      const result = formatDiffForWhatsApp(mockFileDiff);

      expect(result).toContain("📄 *src/test.ts*");
      expect(result).toContain("```"); // No language specifier
      expect(result).not.toContain("```diff"); // WhatsApp doesn't need diff marker
    });

    it("should use shorter labels", () => {
      const result = formatDiffForWhatsApp(mockNewFileDiff);

      expect(result).toContain("_(new)_");
    });
  });

  describe("formatBatchDiffForWhatsApp", () => {
    it("should show compact file list for batches", () => {
      const result = formatBatchDiffForWhatsApp(mockBatchDiff);

      expect(result).toContain("*📋 2 Files Changed*");
      expect(result).toContain("📝 src/test.ts");
      expect(result).toContain("➕ src/new.ts");
    });

    it("should show full diff for single file", () => {
      const singleFileBatch: BatchDiff = {
        files: [mockFileDiff],
        totalStats: mockFileDiff.stats,
        summary: "1 changed",
      };

      const result = formatBatchDiffForWhatsApp(singleFileBatch);

      expect(result).toContain("```");
    });
  });

  describe("formatDiffForCLI", () => {
    it("should include ANSI colors", () => {
      const result = formatDiffForCLI(mockFileDiff);

      expect(result).toContain("\x1b["); // ANSI escape sequences
      expect(result).toContain("M"); // Modified marker
      expect(result).toContain("src/test.ts");
    });

    it("should color additions in green", () => {
      const result = formatDiffForCLI(mockFileDiff);

      expect(result).toContain("\x1b[32m"); // Green for additions
    });

    it("should color deletions in red", () => {
      const result = formatDiffForCLI(mockFileDiff);

      expect(result).toContain("\x1b[31m"); // Red for deletions
    });

    it("should mark new files with 'A'", () => {
      const result = formatDiffForCLI(mockNewFileDiff);

      expect(result).toContain("A");
      expect(result).toContain("\x1b[32m"); // Green
    });

    it("should mark deleted files with 'D'", () => {
      const result = formatDiffForCLI(mockDeletedFileDiff);

      expect(result).toContain("D");
      expect(result).toContain("\x1b[31m"); // Red
    });

    it("should mark renamed files with 'R'", () => {
      const result = formatDiffForCLI(mockRenameDiff);

      expect(result).toContain("R");
      expect(result).toContain("\x1b[33m"); // Yellow
    });
  });

  describe("formatBatchDiffForCLI", () => {
    it("should include header with separator", () => {
      const result = formatBatchDiffForCLI(mockBatchDiff);

      expect(result).toContain("📋 Changes Summary");
      expect(result).toContain("─"); // Separator line
    });

    it("should format all files", () => {
      const result = formatBatchDiffForCLI(mockBatchDiff);

      expect(result).toContain("src/test.ts");
      expect(result).toContain("src/new.ts");
    });
  });

  describe("formatCompactSummary", () => {
    it("should format for telegram", () => {
      const result = formatCompactSummary(mockBatchDiff, "telegram");

      expect(result).toContain("📊 *2 files*");
      expect(result).toContain("`+4/-1`");
    });

    it("should format for whatsapp", () => {
      const result = formatCompactSummary(mockBatchDiff, "whatsapp");

      expect(result).toContain("📊 *2 files*");
      expect(result).toContain("_+4/-1_");
    });

    it("should format for cli", () => {
      const result = formatCompactSummary(mockBatchDiff, "cli");

      expect(result).toContain("📊 2 files");
      expect(result).toContain("\x1b["); // ANSI codes
    });

    it("should use singular for single file", () => {
      const singleFileBatch: BatchDiff = {
        files: [mockFileDiff],
        totalStats: mockFileDiff.stats,
        summary: "1 changed",
      };

      const result = formatCompactSummary(singleFileBatch, "telegram");

      expect(result).toContain("1 file");
      expect(result).not.toContain("1 files");
    });
  });

  describe("formatDiffForChannel", () => {
    it("should route to telegram formatter", () => {
      const result = formatDiffForChannel(mockFileDiff, "telegram");

      expect(result).toContain("📄 *");
      expect(result).toContain("```diff");
    });

    it("should route to whatsapp formatter", () => {
      const result = formatDiffForChannel(mockFileDiff, "whatsapp");

      expect(result).toContain("📄 *");
      expect(result).not.toContain("```diff");
    });

    it("should route to cli formatter", () => {
      const result = formatDiffForChannel(mockFileDiff, "cli");

      expect(result).toContain("\x1b[");
    });
  });

  describe("formatBatchDiffForChannel", () => {
    it("should route to appropriate formatter", () => {
      const tg = formatBatchDiffForChannel(mockBatchDiff, "telegram");
      const wa = formatBatchDiffForChannel(mockBatchDiff, "whatsapp");
      const cli = formatBatchDiffForChannel(mockBatchDiff, "cli");

      expect(tg).toContain("*📋 Changes Summary*");
      expect(wa).toContain("*📋 2 Files Changed*");
      expect(cli).toContain("\x1b[");
    });
  });
});

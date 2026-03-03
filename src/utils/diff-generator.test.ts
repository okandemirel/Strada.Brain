import { describe, it, expect } from "vitest";
import {
  generateFileDiff,
  generateBatchDiff,
  calculateDiffStats,
  truncateDiff,
  formatDiffStats,
  hasChanges,
  generateInlineDiff,
  type FileDiff,
} from "./diff-generator.js";

describe("diff-generator", () => {
  describe("generateFileDiff", () => {
    it("should generate unified diff for file edit", () => {
      const oldContent = "line1\nline2\nline3\n";
      const newContent = "line1\nmodified\nline3\n";

      const result = generateFileDiff("test.txt", "test.txt", oldContent, newContent);

      expect(result.oldPath).toBe("test.txt");
      expect(result.newPath).toBe("test.txt");
      expect(result.isNew).toBe(false);
      expect(result.isDeleted).toBe(false);
      expect(result.diff).toContain("--- test.txt");
      expect(result.diff).toContain("+++ test.txt");
      expect(result.diff).toContain("-line2");
      expect(result.diff).toContain("+modified");
    });

    it("should mark new files correctly", () => {
      const newContent = "new content\n";

      const result = generateFileDiff("/dev/null", "new.txt", "", newContent);

      expect(result.isNew).toBe(true);
      expect(result.isDeleted).toBe(false);
      expect(result.diff).toContain("+++ new.txt");
      expect(result.diff).toContain("+new content");
    });

    it("should mark deleted files correctly", () => {
      const oldContent = "old content\n";

      const result = generateFileDiff("old.txt", "/dev/null", oldContent, "");

      expect(result.isNew).toBe(false);
      expect(result.isDeleted).toBe(true);
      expect(result.diff).toContain("--- old.txt");
      expect(result.diff).toContain("-old content");
    });

    it("should detect rename without content changes", () => {
      const content = "same content\n";

      const result = generateFileDiff("old.txt", "new.txt", content, content);

      expect(result.isRename).toBe(true);
      expect(result.stats.totalChanges).toBe(0);
    });

    it("should respect context lines option", () => {
      const oldContent = "a\nb\nc\nd\ne\n";
      const newContent = "a\nb\nMODIFIED\nd\ne\n";

      const result3 = generateFileDiff("test.txt", "test.txt", oldContent, newContent, {
        contextLines: 1,
      });
      const result10 = generateFileDiff("test.txt", "test.txt", oldContent, newContent, {
        contextLines: 10,
      });

      // More context lines = more lines in output
      expect(result10.diff.split("\n").length).toBeGreaterThan(
        result3.diff.split("\n").length
      );
    });
  });

  describe("calculateDiffStats", () => {
    it("should count additions and deletions correctly", () => {
      const diff = `--- a.txt
+++ b.txt
@@ -1,3 +1,3 @@
 line1
-line2
+modified
 line3
+added
`;

      const stats = calculateDiffStats(diff);

      expect(stats.additions).toBe(2); // +modified, +added
      expect(stats.deletions).toBe(1); // -line2
      expect(stats.hunks).toBe(1);
    });

    it("should handle multiple hunks", () => {
      const diff = `--- a.txt
+++ b.txt
@@ -1,2 +1,2 @@
 line1
-line2
+changed1
@@ -5,2 +5,2 @@
 line5
-line6
+changed2
`;

      const stats = calculateDiffStats(diff);

      expect(stats.hunks).toBe(2);
      expect(stats.additions).toBe(2);
      expect(stats.deletions).toBe(2);
    });

    it("should handle empty diff", () => {
      const stats = calculateDiffStats("");

      expect(stats.additions).toBe(0);
      expect(stats.deletions).toBe(0);
      expect(stats.hunks).toBe(0);
    });
  });

  describe("generateBatchDiff", () => {
    it("should generate diff for multiple files", () => {
      const files = [
        {
          oldPath: "file1.txt",
          newPath: "file1.txt",
          oldContent: "content1",
          newContent: "modified1",
        },
        {
          oldPath: "file2.txt",
          newPath: "file2.txt",
          oldContent: "content2",
          newContent: "modified2",
        },
      ];

      const result = generateBatchDiff(files);

      expect(result.files).toHaveLength(2);
      expect(result.totalStats.additions).toBeGreaterThan(0);
      expect(result.totalStats.deletions).toBeGreaterThan(0);
      expect(result.summary).toContain("2 changed");
    });

    it("should include new files in summary", () => {
      const files = [
        {
          oldPath: "/dev/null",
          newPath: "new.txt",
          oldContent: "",
          newContent: "new content",
        },
        {
          oldPath: "existing.txt",
          newPath: "existing.txt",
          oldContent: "old",
          newContent: "new",
        },
      ];

      const result = generateBatchDiff(files);

      expect(result.summary).toContain("1 added");
      expect(result.summary).toContain("1 changed");
    });

    it("should include deleted files in summary", () => {
      const files = [
        {
          oldPath: "old.txt",
          newPath: "/dev/null",
          oldContent: "to delete",
          newContent: "",
        },
      ];

      const result = generateBatchDiff(files);

      expect(result.summary).toContain("1 deleted");
    });

    it("should calculate totals correctly", () => {
      const files = [
        {
          oldPath: "a.txt",
          newPath: "a.txt",
          oldContent: "line1\nline2\n",
          newContent: "line1\nmodified\n",
        },
        {
          oldPath: "b.txt",
          newPath: "b.txt",
          oldContent: "a\nb\n",
          newContent: "a\nB\n",
        },
      ];

      const result = generateBatchDiff(files);

      const expectedAdditions = result.files[0]!.stats.additions + result.files[1]!.stats.additions;
      const expectedDeletions = result.files[0]!.stats.deletions + result.files[1]!.stats.deletions;

      expect(result.totalStats.additions).toBe(expectedAdditions);
      expect(result.totalStats.deletions).toBe(expectedDeletions);
    });
  });

  describe("truncateDiff", () => {
    it("should not truncate short diffs", () => {
      const diff = "line1\nline2\nline3";

      const result = truncateDiff(diff, 10);

      expect(result).toBe(diff);
    });

    it("should truncate long diffs", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
      const diff = lines.join("\n");

      const result = truncateDiff(diff, 10);

      expect(result).toContain("line0");
      expect(result).toContain("line9");
      expect(result).not.toContain("line10");
      expect(result).toContain("(10 more lines truncated)");
    });

    it("should use default maxLines of 100", () => {
      const lines = Array.from({ length: 150 }, (_, i) => `line${i}`);
      const diff = lines.join("\n");

      const result = truncateDiff(diff);

      expect(result).toContain("truncated");
    });
  });

  describe("formatDiffStats", () => {
    it("should format simple stats", () => {
      const stats = { additions: 5, deletions: 3, modifications: 2, totalChanges: 8, hunks: 1 };

      const result = formatDiffStats(stats);

      expect(result).toBe("+5/-3 (1 hunk)");
    });

    it("should handle zero deletions", () => {
      const stats = { additions: 5, deletions: 0, modifications: 0, totalChanges: 5, hunks: 1 };

      const result = formatDiffStats(stats);

      expect(result).toBe("+5 (1 hunk)");
    });

    it("should handle zero additions", () => {
      const stats = { additions: 0, deletions: 3, modifications: 0, totalChanges: 3, hunks: 1 };

      const result = formatDiffStats(stats);

      expect(result).toBe("-3 (1 hunk)");
    });

    it("should pluralize hunks correctly", () => {
      const stats = { additions: 1, deletions: 1, modifications: 0, totalChanges: 2, hunks: 2 };

      const result = formatDiffStats(stats);

      expect(result).toBe("+1/-1 (2 hunks)");
    });

    it("should show 'no changes' when empty", () => {
      const stats = { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 };

      const result = formatDiffStats(stats);

      expect(result).toBe("no changes");
    });
  });

  describe("hasChanges", () => {
    it("should return true for content changes", () => {
      const diff: FileDiff = {
        oldPath: "a.txt",
        newPath: "a.txt",
        diff: "...",
        stats: { additions: 1, deletions: 1, modifications: 0, totalChanges: 2, hunks: 1 },
        isNew: false,
        isDeleted: false,
        isRename: false,
      };

      expect(hasChanges(diff)).toBe(true);
    });

    it("should return true for new files", () => {
      const diff: FileDiff = {
        oldPath: "/dev/null",
        newPath: "new.txt",
        diff: "...",
        stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 },
        isNew: true,
        isDeleted: false,
        isRename: false,
      };

      expect(hasChanges(diff)).toBe(true);
    });

    it("should return true for deleted files", () => {
      const diff: FileDiff = {
        oldPath: "old.txt",
        newPath: "/dev/null",
        diff: "...",
        stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 },
        isNew: false,
        isDeleted: true,
        isRename: false,
      };

      expect(hasChanges(diff)).toBe(true);
    });

    it("should return true for renames", () => {
      const diff: FileDiff = {
        oldPath: "old.txt",
        newPath: "new.txt",
        diff: "...",
        stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 },
        isNew: false,
        isDeleted: false,
        isRename: true,
      };

      expect(hasChanges(diff)).toBe(true);
    });

    it("should return false for unchanged files", () => {
      const diff: FileDiff = {
        oldPath: "a.txt",
        newPath: "a.txt",
        diff: "",
        stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 0, hunks: 0 },
        isNew: false,
        isDeleted: false,
        isRename: false,
      };

      expect(hasChanges(diff)).toBe(false);
    });
  });

  describe("generateInlineDiff", () => {
    it("should identify added and removed text", () => {
      const oldText = "hello world";
      const newText = "hello there";

      const result = generateInlineDiff(oldText, newText);

      expect(result.removed).toContain("world");
      expect(result.added).toContain("there");
      expect(result.unchanged).toContain("hello");
    });

    it("should handle completely different strings", () => {
      const oldText = "abc";
      const newText = "xyz";

      const result = generateInlineDiff(oldText, newText);

      expect(result.removed).toContain("abc");
      expect(result.added).toContain("xyz");
    });

    it("should handle identical strings", () => {
      const text = "no changes";

      const result = generateInlineDiff(text, text);

      expect(result.removed).toBe("");
      expect(result.added).toBe("");
      expect(result.unchanged).toBe(text);
    });

    it("should preserve whitespace", () => {
      const oldText = "hello  world";
      const newText = "hello world";

      const result = generateInlineDiff(oldText, newText);

      expect(result.unchanged).toContain("hello");
      expect(result.unchanged).toContain("world");
    });
  });
});

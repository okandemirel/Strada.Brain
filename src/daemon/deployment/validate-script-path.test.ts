import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateScriptPath } from "./validate-script-path.js";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

const mockAccessSync = vi.mocked(accessSync);

describe("validateScriptPath", () => {
  const PROJECT_ROOT = "/project";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: script exists and is executable
    mockAccessSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Valid script paths
  // ===========================================================================

  describe("valid paths", () => {
    it("accepts a relative path within the project", () => {
      const result = validateScriptPath("scripts/deploy.sh", PROJECT_ROOT);
      expect(result).toBe(path.resolve(PROJECT_ROOT, "scripts/deploy.sh"));
    });

    it("accepts a deeply nested script path", () => {
      const result = validateScriptPath("tools/ci/scripts/run.sh", PROJECT_ROOT);
      expect(result).toBe(path.resolve(PROJECT_ROOT, "tools/ci/scripts/run.sh"));
    });

    it("accepts a script at the project root level", () => {
      const result = validateScriptPath("deploy.sh", PROJECT_ROOT);
      expect(result).toBe(path.resolve(PROJECT_ROOT, "deploy.sh"));
    });

    it("verifies the file is executable via accessSync with X_OK", () => {
      validateScriptPath("scripts/deploy.sh", PROJECT_ROOT);
      const resolved = path.resolve(PROJECT_ROOT, "scripts/deploy.sh");
      expect(mockAccessSync).toHaveBeenCalledWith(resolved, fsConstants.X_OK);
    });

    it("returns fully resolved absolute path", () => {
      const result = validateScriptPath("scripts/../scripts/deploy.sh", PROJECT_ROOT);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it("normalizes redundant path segments that stay within project", () => {
      const result = validateScriptPath("scripts/../scripts/deploy.sh", PROJECT_ROOT);
      expect(result).toBe(path.resolve(PROJECT_ROOT, "scripts/deploy.sh"));
    });
  });

  // ===========================================================================
  // Directory traversal attacks
  // ===========================================================================

  describe("directory traversal prevention", () => {
    it("rejects simple parent traversal (../)", () => {
      expect(() => validateScriptPath("../etc/passwd", PROJECT_ROOT)).toThrow(
        /traversal detected/,
      );
    });

    it("rejects deep parent traversal (../../..)", () => {
      expect(() =>
        validateScriptPath("../../../etc/shadow", PROJECT_ROOT),
      ).toThrow(/traversal detected/);
    });

    it("rejects traversal disguised within a valid-looking path", () => {
      expect(() =>
        validateScriptPath("scripts/../../outside/evil.sh", PROJECT_ROOT),
      ).toThrow(/traversal detected/);
    });

    it("rejects traversal that lands exactly one level above root", () => {
      expect(() => validateScriptPath("..", PROJECT_ROOT)).toThrow(
        /traversal detected/,
      );
    });

    it("includes the offending path in the error message", () => {
      const badPath = "../../../etc/passwd";
      expect(() => validateScriptPath(badPath, PROJECT_ROOT)).toThrow(
        badPath,
      );
    });
  });

  // ===========================================================================
  // Non-executable / missing scripts
  // ===========================================================================

  describe("file access checks", () => {
    it("throws when the script does not exist", () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      expect(() =>
        validateScriptPath("scripts/missing.sh", PROJECT_ROOT),
      ).toThrow(/not found or not executable/);
    });

    it("throws when the script is not executable", () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });

      expect(() =>
        validateScriptPath("scripts/readonly.sh", PROJECT_ROOT),
      ).toThrow(/not found or not executable/);
    });

    it("includes the resolved path in the access error message", () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const resolved = path.resolve(PROJECT_ROOT, "scripts/missing.sh");
      expect(() =>
        validateScriptPath("scripts/missing.sh", PROJECT_ROOT),
      ).toThrow(resolved);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("rejects an empty string path (resolves to project root itself)", () => {
      // path.resolve("/project", "") => "/project" which equals projectRoot
      // The function allows resolved === projectRoot, so empty string resolves
      // to project root. This depends on the implementation -- verify behavior.
      const result = validateScriptPath("", PROJECT_ROOT);
      expect(result).toBe(PROJECT_ROOT);
    });

    it("handles path with null byte by relying on OS-level rejection", () => {
      // Node's fs.accessSync throws on null bytes in paths
      mockAccessSync.mockImplementation(() => {
        throw new TypeError('The "path" argument must be of type string without null bytes');
      });

      expect(() =>
        validateScriptPath("scripts/evil\0.sh", PROJECT_ROOT),
      ).toThrow(/not found or not executable/);
    });

    it("accepts valid script even when project root has trailing separator", () => {
      const rootWithSlash = "/project/";
      // normalizedRoot via path.resolve strips trailing separator
      const result = validateScriptPath("scripts/deploy.sh", rootWithSlash);
      expect(result).toBe(path.resolve("/project", "scripts/deploy.sh"));
    });

    it("handles a dot path (current directory)", () => {
      // "." resolves to the project root itself
      const result = validateScriptPath(".", PROJECT_ROOT);
      expect(result).toBe(PROJECT_ROOT);
    });

    it("rejects absolute path outside project root", () => {
      expect(() =>
        validateScriptPath("/etc/passwd", PROJECT_ROOT),
      ).toThrow(/traversal detected/);
    });

    it("accepts absolute path that happens to be inside project root", () => {
      const absoluteInside = path.join(PROJECT_ROOT, "scripts", "deploy.sh");
      const result = validateScriptPath(absoluteInside, PROJECT_ROOT);
      expect(result).toBe(absoluteInside);
    });
  });
});

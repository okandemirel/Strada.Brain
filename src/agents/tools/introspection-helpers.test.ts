import { describe, it, expect } from "vitest";
import { buildSection, unavailableSection, checkToolRateLimit } from "./introspection-helpers.js";

describe("introspection-helpers", () => {
  describe("buildSection", () => {
    it("creates markdown heading with bullet items", () => {
      const result = buildSection("Status", ["**Uptime:** 5 min", "**Sessions:** 2"]);
      expect(result).toBe("## Status\n- **Uptime:** 5 min\n- **Sessions:** 2");
    });

    it("handles empty items array", () => {
      expect(buildSection("Empty", [])).toBe("## Empty");
    });
  });

  describe("unavailableSection", () => {
    it("creates a not-available placeholder", () => {
      const result = unavailableSection("Memory", "not initialized");
      expect(result).toBe("## Memory\n\nNot available (not initialized).");
    });
  });

  describe("checkToolRateLimit", () => {
    it("allows calls under the limit", () => {
      // Use a unique tool name to avoid cross-test pollution
      const result = checkToolRateLimit("test_tool_under_limit");
      expect(result).toBeUndefined();
    });

    it("blocks calls over the limit", () => {
      const toolName = "test_tool_over_limit";
      // Exhaust the limit (10 calls)
      for (let i = 0; i < 10; i++) {
        checkToolRateLimit(toolName);
      }
      const result = checkToolRateLimit(toolName);
      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content).toContain("Rate limited");
    });
  });
});

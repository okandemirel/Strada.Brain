import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseCommand,
  isValidWorkspace,
  isValidUser,
} from "../commands.js";

// Mock logger
vi.mock("../../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("Slack Commands", () => {
  describe("parseCommand", () => {
    it("should parse command with arguments", () => {
      const result = parseCommand("/strada-ask How do I create a component?");
      expect(result).toEqual({
        type: "strada-ask",
        args: ["How", "do", "I", "create", "a", "component?"],
      });
    });

    it("should parse command without arguments", () => {
      const result = parseCommand("/strada-help");
      expect(result).toEqual({
        type: "strada-help",
        args: [],
      });
    });

    it("should handle empty string", () => {
      const result = parseCommand("");
      expect(result).toEqual({ type: "", args: [] });
    });

    it("should handle whitespace", () => {
      const result = parseCommand("   ");
      expect(result).toEqual({ type: "", args: [] });
    });
  });

  describe("isValidWorkspace", () => {
    it("should allow valid workspace", () => {
      expect(isValidWorkspace("T123", ["T123", "T456"])).toBe(true);
    });

    it("should deny invalid workspace", () => {
      expect(isValidWorkspace("T789", ["T123", "T456"])).toBe(false);
    });

    it("should deny all when no restrictions configured (closed by default)", () => {
      expect(isValidWorkspace("T123", [])).toBe(false);
    });
  });

  describe("isValidUser", () => {
    it("should allow valid user", () => {
      expect(isValidUser("U123", ["U123", "U456"])).toBe(true);
    });

    it("should deny invalid user", () => {
      expect(isValidUser("U789", ["U123", "U456"])).toBe(false);
    });

    it("should deny all when no restrictions configured (closed by default)", () => {
      expect(isValidUser("U123", [])).toBe(false);
    });
  });
});

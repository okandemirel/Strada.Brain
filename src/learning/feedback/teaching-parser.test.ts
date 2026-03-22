import { describe, it, expect } from "vitest";
import { TeachingParser } from "./teaching-parser.ts";

describe("TeachingParser", () => {
  describe("isTeachingIntent", () => {
    it("should detect EN teaching patterns with colon", () => {
      expect(TeachingParser.isTeachingIntent("remember: always use strict mode")).toBe(true);
      expect(TeachingParser.isTeachingIntent("learn: prefer const over let")).toBe(true);
      expect(TeachingParser.isTeachingIntent("note: this project uses tabs")).toBe(true);
      expect(TeachingParser.isTeachingIntent("memorize: the API key format")).toBe(true);
    });

    it("should detect EN teaching patterns with 'that'", () => {
      expect(TeachingParser.isTeachingIntent("remember that I prefer TypeScript")).toBe(true);
      expect(TeachingParser.isTeachingIntent("learn that we use ESM modules")).toBe(true);
      expect(TeachingParser.isTeachingIntent("note that the config is in root")).toBe(true);
      expect(TeachingParser.isTeachingIntent("memorize that tests go in __tests__")).toBe(true);
    });

    it("should detect TR teaching patterns", () => {
      expect(TeachingParser.isTeachingIntent("hatirla: her zaman strict mode kullan")).toBe(true);
      expect(TeachingParser.isTeachingIntent("ogren: const kullanmayi tercih et")).toBe(true);
      expect(TeachingParser.isTeachingIntent("not et: bu projede tab kullaniyoruz")).toBe(true);
      expect(TeachingParser.isTeachingIntent("unutma: API key formati")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(TeachingParser.isTeachingIntent("REMEMBER: always use strict mode")).toBe(true);
      expect(TeachingParser.isTeachingIntent("Remember that I prefer dark mode")).toBe(true);
      expect(TeachingParser.isTeachingIntent("HATIRLA: her zaman")).toBe(true);
    });

    it("should return false for non-teaching text", () => {
      expect(TeachingParser.isTeachingIntent("fix the bug in main.ts")).toBe(false);
      expect(TeachingParser.isTeachingIntent("what is the status?")).toBe(false);
      expect(TeachingParser.isTeachingIntent("run the tests")).toBe(false);
      expect(TeachingParser.isTeachingIntent("")).toBe(false);
    });
  });

  describe("parse", () => {
    it("should extract content from colon-style teaching", () => {
      const result = TeachingParser.parse("remember: always use strict mode");
      expect(result.content).toBe("always use strict mode");
    });

    it("should extract content from 'that'-style teaching", () => {
      const result = TeachingParser.parse("remember that I prefer TypeScript");
      expect(result.content).toBe("I prefer TypeScript");
    });

    it("should detect 'user' scope hint from 'I prefer'", () => {
      const result = TeachingParser.parse("remember that I prefer tabs");
      expect(result.scope).toBe("user");
    });

    it("should detect 'project' scope hint from 'in this project'", () => {
      const result = TeachingParser.parse("remember: in this project we use ESM");
      expect(result.scope).toBe("project");
    });

    it("should return no scope when no hint present", () => {
      const result = TeachingParser.parse("remember: always handle errors");
      expect(result.scope).toBeUndefined();
    });

    it("should extract content from TR teaching", () => {
      const result = TeachingParser.parse("hatirla: her zaman strict mode kullan");
      expect(result.content).toBe("her zaman strict mode kullan");
    });

    it("should trim whitespace from extracted content", () => {
      const result = TeachingParser.parse("remember:   lots of spaces   ");
      expect(result.content).toBe("lots of spaces");
    });

    it("should return full text as content when pattern not recognized", () => {
      const result = TeachingParser.parse("some random text");
      expect(result.content).toBe("some random text");
    });
  });
});

import { describe, it, expect } from "vitest";
import { CorrectionDetector } from "./correction-detector.ts";

describe("CorrectionDetector", () => {
  describe("isCorrection", () => {
    it("should detect EN correction patterns", () => {
      expect(CorrectionDetector.isCorrection("no, use const instead")).toBe(true);
      expect(CorrectionDetector.isCorrection("wrong, it should be async")).toBe(true);
      expect(CorrectionDetector.isCorrection("instead use the other method")).toBe(true);
      expect(CorrectionDetector.isCorrection("that's incorrect, fix it")).toBe(true);
      expect(CorrectionDetector.isCorrection("actually, do it this way")).toBe(true);
      expect(CorrectionDetector.isCorrection("not like that, do it differently")).toBe(true);
    });

    it("should detect TR correction patterns", () => {
      expect(CorrectionDetector.isCorrection("hayir, const kullan")).toBe(true);
      expect(CorrectionDetector.isCorrection("yanlis, async olmali")).toBe(true);
      expect(CorrectionDetector.isCorrection("dogru degil, baska yol dene")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(CorrectionDetector.isCorrection("NO, use const")).toBe(true);
      expect(CorrectionDetector.isCorrection("Wrong answer")).toBe(true);
      expect(CorrectionDetector.isCorrection("HAYIR, bu yanlis")).toBe(true);
    });

    it("should return false for non-correction text", () => {
      expect(CorrectionDetector.isCorrection("please fix the bug")).toBe(false);
      expect(CorrectionDetector.isCorrection("run the tests")).toBe(false);
      expect(CorrectionDetector.isCorrection("looks good")).toBe(false);
      expect(CorrectionDetector.isCorrection("")).toBe(false);
    });
  });

  describe("isFileCorrection", () => {
    it("should detect file modification within 60s of agent write", () => {
      const agentWriteTime = 1000000;
      const fileModifyTime = 1000000 + 30_000; // 30s later
      const toolLog: Array<{ timestamp: number; endTimestamp: number }> = [];

      expect(CorrectionDetector.isFileCorrection(agentWriteTime, fileModifyTime, toolLog)).toBe(true);
    });

    it("should reject file modification outside 60s window", () => {
      const agentWriteTime = 1000000;
      const fileModifyTime = 1000000 + 61_000; // 61s later
      const toolLog: Array<{ timestamp: number; endTimestamp: number }> = [];

      expect(CorrectionDetector.isFileCorrection(agentWriteTime, fileModifyTime, toolLog)).toBe(false);
    });

    it("should reject modification during agent tool execution window", () => {
      const agentWriteTime = 1000000;
      const fileModifyTime = 1000000 + 10_000; // 10s later, within 60s
      const toolLog = [
        { timestamp: 1000000 + 5_000, endTimestamp: 1000000 + 15_000 }, // tool running 5s-15s after write
      ];

      expect(CorrectionDetector.isFileCorrection(agentWriteTime, fileModifyTime, toolLog)).toBe(false);
    });

    it("should accept modification outside agent tool execution windows", () => {
      const agentWriteTime = 1000000;
      const fileModifyTime = 1000000 + 30_000; // 30s later
      const toolLog = [
        { timestamp: 1000000 + 5_000, endTimestamp: 1000000 + 10_000 }, // tool ran 5s-10s
        { timestamp: 1000000 + 40_000, endTimestamp: 1000000 + 50_000 }, // tool ran 40s-50s
      ];

      expect(CorrectionDetector.isFileCorrection(agentWriteTime, fileModifyTime, toolLog)).toBe(true);
    });

    it("should reject if fileModifyTime is before agentWriteTime", () => {
      const agentWriteTime = 1000000;
      const fileModifyTime = 999000; // before agent write
      const toolLog: Array<{ timestamp: number; endTimestamp: number }> = [];

      expect(CorrectionDetector.isFileCorrection(agentWriteTime, fileModifyTime, toolLog)).toBe(false);
    });
  });
});

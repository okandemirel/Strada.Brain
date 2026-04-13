import { describe, it, expect } from "vitest";
import { parseRecoveryIntent } from "./orchestrator-intent-parser.js";

describe("parseRecoveryIntent", () => {
  it("detects direct Turkish retry phrase", () => {
    const r = parseRecoveryIntent({
      message: "Tekrar dene",
      hasPendingCheckpoint: true,
    });
    expect(r.kind).toBe("retry");
    expect(r.confidence).toBe(0.9);
  });

  it("detects direct English resume phrase", () => {
    const r = parseRecoveryIntent({
      message: "Please continue where you left off",
      hasPendingCheckpoint: true,
    });
    expect(r.kind).toBe("resume");
    expect(r.confidence).toBe(0.9);
  });

  it("detects Turkish budget update with token count", () => {
    const r = parseRecoveryIntent({
      message: "Bütçeyi 500k arttırdım, devam et",
      hasPendingCheckpoint: true,
      lastCheckpointStage: "budget_exceeded",
    });
    expect(r.kind).toBe("update_budget");
    if (r.kind === "update_budget") {
      expect(r.tokenK).toBe(500);
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("extracts budget from 'budget 500k' keyword+number", () => {
    const r = parseRecoveryIntent({
      message: "budget 500k",
      hasPendingCheckpoint: false,
    });
    expect(r.kind).toBe("update_budget");
    if (r.kind === "update_budget") {
      expect(r.tokenK).toBe(500);
    }
  });

  it("returns none for unrelated chit-chat", () => {
    const r = parseRecoveryIntent({
      message: "How's the weather today?",
      hasPendingCheckpoint: true,
    });
    expect(r.kind).toBe("none");
    expect(r.confidence).toBe(0);
  });

  it("requires pending checkpoint for weak Turkish 'devam'", () => {
    const withCp = parseRecoveryIntent({
      message: "şimdi devam konusu",
      hasPendingCheckpoint: true,
    });
    const withoutCp = parseRecoveryIntent({
      message: "şimdi devam konusu",
      hasPendingCheckpoint: false,
    });
    expect(withCp.kind).toBe("resume");
    expect(withCp.confidence).toBe(0.5);
    expect(withoutCp.kind).toBe("none");
  });

  it("treats contextual budget keyword + budget_exceeded checkpoint as weak budget intent", () => {
    const r = parseRecoveryIntent({
      message: "token limit yeterli",
      hasPendingCheckpoint: true,
      lastCheckpointStage: "budget_exceeded",
    });
    expect(r.kind).toBe("update_budget");
    expect(r.confidence).toBe(0.5);
  });

  it("budget-update outranks retry when both appear", () => {
    const r = parseRecoveryIntent({
      message: "I raised the budget, try again",
      hasPendingCheckpoint: true,
      lastCheckpointStage: "budget_exceeded",
    });
    expect(r.kind).toBe("update_budget");
  });

  it("diacritic-stripped match: 'butceyi arttirdim'", () => {
    const r = parseRecoveryIntent({
      message: "butceyi arttirdim",
      hasPendingCheckpoint: true,
    });
    expect(r.kind).toBe("update_budget");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("empty string returns none", () => {
    const r = parseRecoveryIntent({
      message: "   ",
      hasPendingCheckpoint: true,
    });
    expect(r.kind).toBe("none");
  });
});

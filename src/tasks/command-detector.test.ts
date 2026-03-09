/**
 * Command Detector Tests (Phase 16-01)
 *
 * Tests for /goal command detection:
 * - detectCommand("/goal build a REST API") returns goal command with args
 * - detectCommand("/hedef REST API olustur") returns goal command (Turkish)
 * - detectCommand("/goal list") returns goal command with "list" arg
 * - detectCommand("/goal cancel task_abc123") returns goal command with cancel args
 * - detectCommand("/goal") returns goal command with empty args
 * - detectCommand("build me a website") returns task_request (not intercepted)
 */

import { describe, it, expect } from "vitest";
import { detectCommand } from "./command-detector.js";

describe("detectCommand /goal", () => {
  it('"/goal build a REST API" returns goal command with args', () => {
    const result = detectCommand("/goal build a REST API");
    expect(result).toEqual({
      type: "command",
      command: "goal",
      args: ["build", "a", "REST", "API"],
    });
  });

  it('"/hedef REST API olustur" returns goal command (Turkish)', () => {
    const result = detectCommand("/hedef REST API olustur");
    expect(result).toEqual({
      type: "command",
      command: "goal",
      args: ["REST", "API", "olustur"],
    });
  });

  it('"/goal list" returns goal command with list arg', () => {
    const result = detectCommand("/goal list");
    expect(result).toEqual({
      type: "command",
      command: "goal",
      args: ["list"],
    });
  });

  it('"/goal cancel task_abc123" returns goal command with cancel args', () => {
    const result = detectCommand("/goal cancel task_abc123");
    expect(result).toEqual({
      type: "command",
      command: "goal",
      args: ["cancel", "task_abc123"],
    });
  });

  it('"/goal" returns goal command with empty args', () => {
    const result = detectCommand("/goal");
    expect(result).toEqual({
      type: "command",
      command: "goal",
      args: [],
    });
  });

  it('"build me a website" returns task_request (not intercepted as /goal)', () => {
    const result = detectCommand("build me a website");
    expect(result).toEqual({
      type: "task_request",
      prompt: "build me a website",
    });
  });
});

describe("detectCommand existing commands still work", () => {
  it("/status returns status command", () => {
    const result = detectCommand("/status");
    expect(result).toEqual({
      type: "command",
      command: "status",
      args: [],
    });
  });

  it("/cancel returns cancel command", () => {
    const result = detectCommand("/cancel");
    expect(result).toEqual({
      type: "command",
      command: "cancel",
      args: [],
    });
  });
});

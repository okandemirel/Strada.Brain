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

describe("detectCommand /autonomous", () => {
  it('"/autonomous on" returns autonomous command with on arg', () => {
    const result = detectCommand("/autonomous on");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: ["on"],
    });
  });

  it('"/autonomous off" returns autonomous command with off arg', () => {
    const result = detectCommand("/autonomous off");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: ["off"],
    });
  });

  it('"/autonomous" with no args returns autonomous command (status)', () => {
    const result = detectCommand("/autonomous");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: [],
    });
  });

  it('"/autonomous on 48" returns autonomous command with on and duration args', () => {
    const result = detectCommand("/autonomous on 48");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: ["on", "48"],
    });
  });

  it('"/otonom on" returns autonomous command (Turkish alias)', () => {
    const result = detectCommand("/otonom on");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: ["on"],
    });
  });

  it('"/autonomy off" returns autonomous command (alias)', () => {
    const result = detectCommand("/autonomy off");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: ["off"],
    });
  });

  it('"/otonomi" returns autonomous command (Turkish alias, no args)', () => {
    const result = detectCommand("/otonomi");
    expect(result).toEqual({
      type: "command",
      command: "autonomous",
      args: [],
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

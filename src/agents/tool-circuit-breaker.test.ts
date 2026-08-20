/**
 * A tool that fails on different things is not a broken tool.
 *
 * Measured 2026-08-20: an agent probed seven files that did not exist, one in
 * each of seven modules — ordinary exploration, every call a different path —
 * and file_read was taken away for the rest of the run. The breaker counted
 * the tool, not the repetition, so doing the obvious thing seven times looked
 * identical to a tool that had stopped working.
 *
 * The opposite failure is real too: a genuinely broken tool fails on every
 * target, and refusing to ever disable it leaves the run hammering it. So the
 * tool-level count survives, far enough out that exploration cannot reach it.
 */

import { describe, it, expect } from "vitest";
import { Orchestrator } from "./orchestrator.js";

type Breaker = {
  toolConsecutiveErrors: Map<string, Map<string, number>>;
  trackToolError(chatId: string, tool: string, isError: boolean, target?: string): void;
  toolIsCircuitBroken(chatId: string, tool: string, target?: string): number | null;
};

function breaker(): Breaker {
  return Object.create(Orchestrator.prototype, {
    toolConsecutiveErrors: { value: new Map(), writable: true },
  }) as unknown as Breaker;
}

describe("what counts as a broken tool", () => {
  it("keeps the tool when each failure is a different target", () => {
    const b = breaker();

    for (const module of ["Pig", "Board", "Level", "Input", "UI", "Scoring", "GameFlow"]) {
      b.trackToolError("c", "file_read", true, `Assets/Modules/${module}Module/Missing.cs`);
    }

    expect(
      b.toolIsCircuitBroken("c", "file_read", "Assets/Modules/AnotherModule/Missing.cs"),
      "seven distinct misses disabled the tool",
    ).toBeNull();
  });

  it("stops the same call repeating", () => {
    const b = breaker();

    for (let i = 0; i < 3; i++) b.trackToolError("c", "file_read", true, "same.cs");

    expect(b.toolIsCircuitBroken("c", "file_read", "same.cs")).toBe(3);
  });

  it("still disables a tool that fails on everything", () => {
    const b = breaker();

    for (let i = 0; i < 12; i++) b.trackToolError("c", "file_read", true, `f${i}.cs`);

    expect(b.toolIsCircuitBroken("c", "file_read", "f99.cs")).toBe(12);
  });

  it("a success clears both counts", () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.trackToolError("c", "file_read", true, "same.cs");

    b.trackToolError("c", "file_read", false, "same.cs");

    expect(b.toolIsCircuitBroken("c", "file_read", "same.cs")).toBeNull();
  });

  it("keeps chats apart", () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.trackToolError("a", "file_read", true, "same.cs");

    expect(b.toolIsCircuitBroken("b", "file_read", "same.cs")).toBeNull();
  });
});

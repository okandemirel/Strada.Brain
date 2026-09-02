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
  toolConsecutiveErrors: Map<string, Map<string, { count: number; trippedAtMs?: number }>>;
  trackToolError(scope: string, tool: string, isError: boolean, target?: string): void;
  toolIsCircuitBroken(
    scope: string,
    tool: string,
    target?: string,
    nowMs?: number,
  ): { count: number; measured: string; retryAfterMs: number } | null;
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

    expect(b.toolIsCircuitBroken("c", "file_read", "same.cs")).toMatchObject({ count: 3, measured: "same target" });
  });

  it("still disables a tool that fails on everything", () => {
    const b = breaker();

    for (let i = 0; i < 12; i++) b.trackToolError("c", "file_read", true, `f${i}.cs`);

    expect(b.toolIsCircuitBroken("c", "file_read", "f99.cs")).toMatchObject({ count: 12, measured: "across targets" });
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

// audited 2026-09-02: the refusal said "temporarily disabled" but nothing
// implemented "temporarily". The guard returned before trackToolError, so a
// tripped counter could never be decremented, and the only reset (a success)
// needed a call the breaker itself refused. One node's twelve misses took a
// mutating tool away from every later node on the chatId for good.
describe("the trip is temporary", () => {
  const COOLDOWN = 60_000;

  it("stays tripped inside the cooldown", () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.trackToolError("c", "file_write", true, "same.cs");

    const first = b.toolIsCircuitBroken("c", "file_write", "same.cs", 1_000);
    expect(first).toMatchObject({ count: 3 });
    expect(first?.retryAfterMs).toBe(COOLDOWN);

    const later = b.toolIsCircuitBroken("c", "file_write", "same.cs", 1_000 + COOLDOWN / 2);
    expect(later).toMatchObject({ count: 3 });
    expect(later?.retryAfterMs).toBe(COOLDOWN / 2);
  });

  it("admits one probe after the cooldown; a failing probe re-trips, a passing one clears", () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.trackToolError("c", "file_write", true, "same.cs");
    b.toolIsCircuitBroken("c", "file_write", "same.cs", 1_000); // trips the clock

    expect(
      b.toolIsCircuitBroken("c", "file_write", "same.cs", 1_000 + COOLDOWN),
      "the cooldown elapsed and the tool was still refused",
    ).toBeNull();

    // The probe fails: refused again, with a fresh cooldown from now.
    b.trackToolError("c", "file_write", true, "same.cs");
    const retripped = b.toolIsCircuitBroken("c", "file_write", "same.cs", 2_000 + COOLDOWN);
    expect(retripped).toMatchObject({ count: 3 });
    expect(retripped?.retryAfterMs).toBe(COOLDOWN);

    // Next probe succeeds: cleared.
    b.toolIsCircuitBroken("c", "file_write", "same.cs", 2_000 + 2 * COOLDOWN);
    b.trackToolError("c", "file_write", false, "same.cs");
    expect(b.toolIsCircuitBroken("c", "file_write", "same.cs", 2_000 + 2 * COOLDOWN)).toBeNull();
  });

  it("reopens the tool-wide trip the same way", () => {
    const b = breaker();
    for (let i = 0; i < 12; i++) b.trackToolError("c", "file_write", true, `f${i}.cs`);
    expect(b.toolIsCircuitBroken("c", "file_write", "new.cs", 0)).toMatchObject({ count: 12 });

    expect(b.toolIsCircuitBroken("c", "file_write", "new.cs", COOLDOWN)).toBeNull();
  });
});

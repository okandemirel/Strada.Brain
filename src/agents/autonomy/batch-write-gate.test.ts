/**
 * What the batch gate has to read before anything is allowed to run.
 *
 * The failure this guards against is not a malformed batch — it is a batch the
 * reviewer could not read being treated as a batch with nothing in it. That is
 * how 368 writes reached disk without passing a gate.
 */

import { describe, it, expect } from "vitest";
import { parseBatchOperations, BATCH_DISPATCH_TOOLS } from "./batch-write-gate.js";

describe("reading a batch's operations", () => {
  it("reads a well-formed batch", () => {
    const parsed = parseBatchOperations({
      operations: [
        { tool: "file_write", input: { path: "Assets/A.cs", content: "// a" } },
        { tool: "file_read", input: { path: "Assets/B.cs" } },
      ],
    });

    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.operations).toEqual([
      { tool: "file_write", input: { path: "Assets/A.cs", content: "// a" } },
      { tool: "file_read", input: { path: "Assets/B.cs" } },
    ]);
  });

  it("trims a tool name so a padded one still matches the write list", () => {
    const parsed = parseBatchOperations({
      operations: [{ tool: "  file_delete  ", input: { path: "Assets/A.cs" } }],
    });

    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.operations[0]?.tool).toBe("file_delete");
  });

  describe("refuses to read, rather than reading as empty", () => {
    // Each of these would otherwise produce "no write operations found" and be
    // approved — the exact shape of the original hole.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["operations missing", {}],
      ["operations not an array", { operations: "file_write" }],
      ["operations empty", { operations: [] }],
      ["an entry that is not an object", { operations: ["file_write"] }],
      ["an entry that is an array", { operations: [[]] }],
      ["an entry with no tool name", { operations: [{ input: {} }] }],
      ["an entry whose tool name is blank", { operations: [{ tool: "   ", input: {} }] }],
      ["an entry with no input", { operations: [{ tool: "file_write" }] }],
      ["an entry whose input is an array", { operations: [{ tool: "file_write", input: [] }] }],
      ["an entry whose input is null", { operations: [{ tool: "file_write", input: null }] }],
    ];

    for (const [name, input] of cases) {
      it(name, () => {
        const parsed = parseBatchOperations(input);
        expect(parsed.kind, `${name} was read as reviewable`).toBe("unreviewable");
      });
    }
  });

  it("refuses a batch nested inside a batch", () => {
    // Recursive review with attacker-controlled depth is not a review.
    const parsed = parseBatchOperations({
      operations: [{ tool: "batch_execute", input: { operations: [] } }],
    });

    expect(parsed.kind).toBe("unreviewable");
    if (parsed.kind !== "unreviewable") return;
    expect(parsed.reason).toMatch(/nests batch_execute/);
  });

  it("names the offending operation so the refusal is actionable", () => {
    const parsed = parseBatchOperations({
      operations: [
        { tool: "file_write", input: { path: "Assets/A.cs" } },
        { tool: "shell_exec" },
      ],
    });

    expect(parsed.kind).toBe("unreviewable");
    if (parsed.kind !== "unreviewable") return;
    expect(parsed.reason).toContain("1");
    expect(parsed.reason).toContain("shell_exec");
  });

  it("knows which tools dispatch a nested list", () => {
    expect(BATCH_DISPATCH_TOOLS.has("batch_execute")).toBe(true);
    expect(BATCH_DISPATCH_TOOLS.has("file_write")).toBe(false);
  });
});

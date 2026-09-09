import { describe, it, expect } from "vitest";
import { summarizeToolSchemaSizes, toolSchemaChars } from "./tool-schema-budget.js";

describe("tool schema budget", () => {
  const def = (name: string, descLen: number) => ({ name, description: "d".repeat(descLen), input_schema: { type: "object", properties: {} } });

  it("sizes each definition as the provider sees it and ranks the largest first", () => {
    const defs = [def("small", 10), def("big", 1000), def("mid", 100)];
    const budget = summarizeToolSchemaSizes(defs, 2);
    expect(budget.tools).toBe(3);
    expect(budget.totalChars).toBe(defs.reduce((s, d) => s + toolSchemaChars(d), 0));
    expect(budget.largest.map((l) => l.name)).toEqual(["big", "mid"]);
    expect(budget.largest[0]!.chars).toBe(toolSchemaChars(defs[1]!));
    expect(budget.largestShare).toBeCloseTo((toolSchemaChars(defs[1]!) + toolSchemaChars(defs[2]!)) / budget.totalChars, 6);
  });

  it("an empty list is zero, not NaN", () => {
    const budget = summarizeToolSchemaSizes([]);
    expect(budget).toEqual({ tools: 0, totalChars: 0, largest: [], largestShare: 0 });
  });
});

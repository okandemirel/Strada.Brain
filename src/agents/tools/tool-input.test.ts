import { describe, it, expect } from "vitest";
import { integerArg } from "./tool-input.js";

describe("integerArg (TLS-17)", () => {
  it("accepts integers and digit strings, and leaves an absent value to the default", () => {
    expect(integerArg({ n: 5 }, "n")).toEqual({ ok: true, value: 5 });
    expect(integerArg({ n: " 20 " }, "n")).toEqual({ ok: true, value: 20 });
    expect(integerArg({ n: -3 }, "n")).toEqual({ ok: true, value: -3 });
    expect(integerArg({}, "n")).toEqual({ ok: true, value: undefined });
    expect(integerArg({ n: null }, "n")).toEqual({ ok: true, value: undefined });
  });

  it("refuses what would have become NaN (or a fraction), by name", () => {
    for (const bad of ["abc", "", "1e3", 2.5, Number.NaN, true, [3], {}]) {
      const result = integerArg({ count: bad }, "count");
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.error).toContain("'count' must be an integer");
    }
  });
});

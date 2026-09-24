// SEC-1: the trust scan and the loader decide a skill's entry point by one
// rule, from the directory listing.
import { describe, it, expect } from "vitest";
import { SKILL_ENTRY_POINTS, findSkillEntryPoint } from "./skill-entry-point.js";

describe("findSkillEntryPoint", () => {
  it("prefers the exact names in loader order", () => {
    expect(SKILL_ENTRY_POINTS).toEqual(["index.ts", "index.js"]);
    expect(findSkillEntryPoint(["SKILL.md", "index.js", "index.ts"])).toEqual({ name: "index.ts", exact: true });
    expect(findSkillEntryPoint(["index.js", "Index.ts"])).toEqual({ name: "index.js", exact: true });
  });

  it("reports a name that only differs in case as a non-exact entry point", () => {
    expect(findSkillEntryPoint(["SKILL.md", "Index.js"])).toEqual({ name: "Index.js", exact: false });
    expect(findSkillEntryPoint(["INDEX.TS"])).toEqual({ name: "INDEX.TS", exact: false });
    // Letters that upcase onto ASCII (dotless i, long s), as a case-insensitive filesystem compares them.
    expect(findSkillEntryPoint(["ındex.js"])).toEqual({ name: "ındex.js", exact: false });
    expect(findSkillEntryPoint(["index.jſ"])).toEqual({ name: "index.jſ", exact: false });
  });

  it("ignores names that are not an entry point in any case", () => {
    expect(findSkillEntryPoint([])).toBeNull();
    expect(findSkillEntryPoint(["SKILL.md", "index.mjs", "index.jsx", "my-index.js", "index.js.bak"])).toBeNull();
  });
});

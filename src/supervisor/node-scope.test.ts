import { describe, it, expect } from "vitest";
import { NODE_SCOPE_DIRECTIVE, withNodeScope } from "./node-scope.js";

describe("node scope directive", () => {
  it("appends the directive after the task, once", () => {
    const prompt = withNodeScope("Do X");
    expect(prompt.startsWith("Do X\n\n## Scope of this node")).toBe(true);
    expect(prompt.split("## Scope of this node")).toHaveLength(2);
    expect(NODE_SCOPE_DIRECTIVE).toContain("its output is the deliverable");
  });
});

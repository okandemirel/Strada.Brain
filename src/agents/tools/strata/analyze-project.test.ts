import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnalyzeProjectTool } from "./analyze-project.js";
import { createToolContext } from "../../../test-helpers.js";

const mockAnalysis = {
  modules: [],
  systems: [],
  components: [],
  services: [],
  mediators: [],
  controllers: [],
  events: [],
  csFileCount: 10,
  analyzedAt: new Date("2026-01-01"),
};

vi.mock("../../../intelligence/strata-analyzer.js", () => {
  const MockClass = vi.fn().mockImplementation(() => ({
    analyze: vi.fn().mockResolvedValue(mockAnalysis),
  }));
  // Static method on the class
  (MockClass as any).formatAnalysis = vi.fn().mockReturnValue("Strada Project Analysis\nMocked output");
  return { StrataAnalyzer: MockClass };
});

import { StrataAnalyzer } from "../../../intelligence/strata-analyzer.js";

describe("AnalyzeProjectTool", () => {
  let tool: AnalyzeProjectTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new AnalyzeProjectTool();
    vi.clearAllMocks();
  });

  it("returns formatted analysis", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Strada Project Analysis");
    expect(StrataAnalyzer).toHaveBeenCalledWith(ctx.projectPath);
  });

  it("returns error when analysis fails", async () => {
    vi.mocked(StrataAnalyzer).mockImplementationOnce(() => ({
      analyze: vi.fn().mockRejectedValue(new Error("fail")),
    }) as any);

    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("could not analyze");
  });
});

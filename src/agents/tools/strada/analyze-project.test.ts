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

vi.mock("../../../intelligence/strada-analyzer.js", () => {
  const MockClass = vi.fn().mockImplementation(function () {
    return { analyze: vi.fn().mockResolvedValue(mockAnalysis) };
  });
  // Static method on the class
  (MockClass as any).formatAnalysis = vi.fn().mockReturnValue("Strada Project Analysis\nMocked output");
  return { StradaAnalyzer: MockClass };
});

import { StradaAnalyzer } from "../../../intelligence/strada-analyzer.js";

describe("AnalyzeProjectTool", () => {
  let tool: AnalyzeProjectTool;
  const ctx = createToolContext();

  beforeEach(() => {
    tool = new AnalyzeProjectTool();
  });

  it("returns formatted analysis", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Strada Project Analysis");
    expect(StradaAnalyzer).toHaveBeenCalledWith(ctx.projectPath);
  });

  it("returns error when analysis fails", async () => {
    vi.mocked(StradaAnalyzer).mockImplementationOnce(() => ({
      analyze: vi.fn().mockRejectedValue(new Error("fail")),
    }) as any);

    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("could not analyze");
  });
});

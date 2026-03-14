import { describe, it, expect, vi } from "vitest";
import { SwitchPersonalityTool } from "./switch-personality.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("SwitchPersonalityTool", () => {
  const tool = new SwitchPersonalityTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("switch_personality");
    expect(tool.inputSchema.properties.profile.enum).toEqual(["casual", "formal", "minimal", "default"]);
  });

  it("returns error for unknown profile", async () => {
    const result = await tool.execute({ profile: "unknown" }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown profile");
  });

  it("switches profile when soulLoader available", async () => {
    const mockSoulLoader = { switchProfile: vi.fn().mockResolvedValue(true) };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "casual" }, context);
    expect(result.content).toContain("casual");
    expect(mockSoulLoader.switchProfile).toHaveBeenCalledWith("casual");
  });

  it("handles missing soulLoader gracefully", async () => {
    const result = await tool.execute({ profile: "formal" }, {} as any);
    expect(result.content).toContain("formal");
    expect(result.isError).toBeUndefined();
  });

  it("handles switchProfile failure", async () => {
    const mockSoulLoader = { switchProfile: vi.fn().mockResolvedValue(false) };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "casual" }, context);
    expect(result.isError).toBe(true);
  });
});

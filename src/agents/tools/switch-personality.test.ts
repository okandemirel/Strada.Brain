import { describe, it, expect, vi } from "vitest";
import { SwitchPersonalityTool } from "./switch-personality.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("SwitchPersonalityTool", () => {
  const tool = new SwitchPersonalityTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("switch_personality");
    // No enum constraint — accepts any profile name
    expect(tool.inputSchema.properties.profile.type).toBe("string");
    expect((tool.inputSchema.properties.profile as Record<string, unknown>).enum).toBeUndefined();
  });

  it("returns error for unknown profile", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "formal", "minimal", "default"]),
      getProfileContent: vi.fn().mockResolvedValue(null),
    };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "unknown" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown profile");
  });

  it("switches profile when soulLoader available", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "formal", "minimal", "default"]),
      getProfileContent: vi.fn().mockResolvedValue("casual profile content"),
    };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "casual" }, context);
    expect(result.content).toContain("casual");
    expect(result.isError).toBeUndefined();
    expect(mockSoulLoader.getProfiles).toHaveBeenCalled();
  });

  it("handles missing soulLoader gracefully", async () => {
    const result = await tool.execute({ profile: "formal" }, {} as any);
    expect(result.content).toContain("formal");
    expect(result.isError).toBeUndefined();
  });

  it("switches to default profile", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "formal", "minimal", "default"]),
      getProfileContent: vi.fn(),
    };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "default" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("default");
  });

  it("supports custom profiles dynamically", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "formal", "minimal", "default", "pirate"]),
      getProfileContent: vi.fn(),
    };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "pirate" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("pirate");
  });

  it("persists per-user via userProfileStore when chatId present", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "formal", "minimal", "default"]),
      getProfileContent: vi.fn().mockResolvedValue("casual content"),
    };
    const mockUserProfileStore = { setActivePersona: vi.fn() };
    const context = { soulLoader: mockSoulLoader, userProfileStore: mockUserProfileStore, chatId: "user-123" } as any;
    await tool.execute({ profile: "casual" }, context);
    expect(mockUserProfileStore.setActivePersona).toHaveBeenCalledWith("user-123", "casual");
  });

  it("skips userProfileStore persistence when chatId is absent", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "formal", "minimal", "default"]),
      getProfileContent: vi.fn().mockResolvedValue("casual content"),
    };
    const mockUserProfileStore = { setActivePersona: vi.fn() };
    const context = { soulLoader: mockSoulLoader, userProfileStore: mockUserProfileStore } as any;
    await tool.execute({ profile: "casual" }, context);
    expect(mockUserProfileStore.setActivePersona).not.toHaveBeenCalled();
  });

  it("returns error when profile is not in available list", async () => {
    const mockSoulLoader = {
      getProfiles: vi.fn().mockReturnValue(["casual", "default"]),
      getProfileContent: vi.fn(),
    };
    const context = { soulLoader: mockSoulLoader } as any;
    const result = await tool.execute({ profile: "nonexistent" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown profile");
  });

  it("returns error for empty profile name", async () => {
    const result = await tool.execute({ profile: "" }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });
});

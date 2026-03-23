import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSkillConfig, writeSkillConfig, setSkillEnabled } from "./skill-config.js";
import type { SkillConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Mock fs and os so tests don't touch the real filesystem
// ---------------------------------------------------------------------------

const fsMock = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
};

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => fsMock.readFile(...args),
  writeFile: (...args: unknown[]) => fsMock.writeFile(...args),
  mkdir: (...args: unknown[]) => fsMock.mkdir(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

beforeEach(() => {
  fsMock.readFile.mockReset();
  fsMock.writeFile.mockReset();
  fsMock.mkdir.mockReset();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readSkillConfig", () => {
  it("returns default empty config when file does not exist", async () => {
    fsMock.readFile.mockRejectedValue(new Error("ENOENT"));

    const config = await readSkillConfig();
    expect(config).toEqual({ entries: {} });
  });

  it("parses and returns valid config from file", async () => {
    const stored: SkillConfig = {
      entries: {
        gmail: { enabled: true, env: { API_KEY: "abc" } },
      },
    };
    fsMock.readFile.mockResolvedValue(JSON.stringify(stored));

    const config = await readSkillConfig();
    expect(config.entries["gmail"]).toBeDefined();
    expect(config.entries["gmail"]!.enabled).toBe(true);
    expect(config.entries["gmail"]!.env).toEqual({ API_KEY: "abc" });
  });

  it("returns default when file contains invalid JSON", async () => {
    fsMock.readFile.mockResolvedValue("not-json{{{");

    const config = await readSkillConfig();
    expect(config).toEqual({ entries: {} });
  });

  it("returns default when entries field is missing", async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ version: 1 }));

    const config = await readSkillConfig();
    expect(config).toEqual({ entries: {} });
  });
});

describe("writeSkillConfig", () => {
  it("creates directory and writes config file", async () => {
    const config: SkillConfig = {
      entries: {
        gmail: { enabled: true },
      },
    };

    await writeSkillConfig(config);

    expect(fsMock.mkdir).toHaveBeenCalledWith("/mock-home/.strada", { recursive: true });
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      "/mock-home/.strada/skills.json",
      expect.stringContaining('"gmail"'),
      "utf-8",
    );
  });

  it("writes pretty-printed JSON with trailing newline", async () => {
    await writeSkillConfig({ entries: {} });

    const written = fsMock.writeFile.mock.calls[0]![1] as string;
    expect(written.endsWith("\n")).toBe(true);
    // Verify it's properly formatted (indented)
    expect(written).toContain("  ");
  });
});

describe("setSkillEnabled", () => {
  it("creates a new entry when skill does not exist", async () => {
    fsMock.readFile.mockRejectedValue(new Error("ENOENT"));

    await setSkillEnabled("new-skill", true);

    expect(fsMock.writeFile).toHaveBeenCalled();
    const written = JSON.parse(fsMock.writeFile.mock.calls[0]![1] as string) as SkillConfig;
    expect(written.entries["new-skill"]).toBeDefined();
    expect(written.entries["new-skill"]!.enabled).toBe(true);
  });

  it("updates an existing entry, preserving other fields", async () => {
    const existing: SkillConfig = {
      entries: {
        gmail: { enabled: true, env: { KEY: "val" } },
      },
    };
    fsMock.readFile.mockResolvedValue(JSON.stringify(existing));

    await setSkillEnabled("gmail", false);

    const written = JSON.parse(fsMock.writeFile.mock.calls[0]![1] as string) as SkillConfig;
    expect(written.entries["gmail"]!.enabled).toBe(false);
    expect(written.entries["gmail"]!.env).toEqual({ KEY: "val" });
  });

  it("preserves other skills when updating one", async () => {
    const existing: SkillConfig = {
      entries: {
        gmail: { enabled: true },
        slack: { enabled: true },
      },
    };
    fsMock.readFile.mockResolvedValue(JSON.stringify(existing));

    await setSkillEnabled("gmail", false);

    const written = JSON.parse(fsMock.writeFile.mock.calls[0]![1] as string) as SkillConfig;
    expect(written.entries["gmail"]!.enabled).toBe(false);
    expect(written.entries["slack"]!.enabled).toBe(true);
  });
});

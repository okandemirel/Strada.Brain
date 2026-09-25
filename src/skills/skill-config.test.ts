import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { readSkillConfig, writeSkillConfig, setSkillEnabled } from "./skill-config.js";
import type { SkillConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Mock fs and os so tests don't touch the real filesystem
// ---------------------------------------------------------------------------

const fsMock = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
};

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => fsMock.readFile(...args),
  writeFile: (...args: unknown[]) => fsMock.writeFile(...args),
  mkdir: (...args: unknown[]) => fsMock.mkdir(...args),
  rename: (...args: unknown[]) => fsMock.rename(...args),
  unlink: (...args: unknown[]) => fsMock.unlink(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

/** A missing file, as node:fs reports it (the code is what tells it from a broken one). */
function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

beforeEach(() => {
  fsMock.readFile.mockReset();
  fsMock.writeFile.mockReset();
  fsMock.mkdir.mockReset();
  fsMock.rename.mockReset();
  fsMock.unlink.mockReset();
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.rename.mockResolvedValue(undefined);
  fsMock.unlink.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readSkillConfig", () => {
  it("returns default empty config when file does not exist", async () => {
    fsMock.readFile.mockRejectedValue(enoent());

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

  it("marks a file with invalid JSON unreadable instead of treating it as empty (SEC-15)", async () => {
    fsMock.readFile.mockResolvedValue("not-json{{{");

    const config = await readSkillConfig();
    expect(config.entries).toEqual({});
    expect(config.unreadable).toMatch(/invalid JSON/);
  });

  it("marks a file it cannot read unreadable; only a missing file is empty (SEC-15)", async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    expect((await readSkillConfig()).unreadable).toMatch(/EACCES/);
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

    expect(fsMock.mkdir).toHaveBeenCalledWith(join("/mock-home", ".strada"), { recursive: true });
    // SEC-15: written to a temp file beside it, then renamed over it (atomic).
    const target = join("/mock-home", ".strada", "skills.json");
    const [temp, text] = fsMock.writeFile.mock.calls[0] as [string, string];
    expect(temp.startsWith(`${target}.`) && temp.endsWith(".tmp")).toBe(true);
    expect(text).toContain('"gmail"');
    expect(fsMock.rename).toHaveBeenCalledWith(temp, target);
  });

  it("never truncates skills.json in place, and removes its temp file when the rename fails (SEC-15)", async () => {
    fsMock.rename.mockRejectedValue(new Error("EPERM"));
    await expect(writeSkillConfig({ entries: {} })).rejects.toThrow(/EPERM/);
    const temp = fsMock.writeFile.mock.calls[0]![0] as string;
    expect(temp).not.toBe(join("/mock-home", ".strada", "skills.json"));
    expect(fsMock.unlink).toHaveBeenCalledWith(temp);
  });

  it("does not persist the unreadable marker", async () => {
    await writeSkillConfig({ entries: {}, unreadable: "x" });
    expect(JSON.parse(fsMock.writeFile.mock.calls[0]![1] as string)).toEqual({ entries: {} });
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
    fsMock.readFile.mockRejectedValue(enoent());

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

  it("refuses to rewrite a skills.json it cannot parse, which would drop the other entries (SEC-15)", async () => {
    fsMock.readFile.mockResolvedValue('{"entries": {"compromised": {"enabled": fal');
    await expect(setSkillEnabled("other", false)).rejects.toThrow(/could not be read/);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
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

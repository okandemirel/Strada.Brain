import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SoulLoader } from "./soul-loader.js";
import { writeFile, unlink, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("SoulLoader", () => {
  let testDir: string;
  let loader: SoulLoader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `soul-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (loader) loader.shutdown();
    try { await unlink(join(testDir, "soul.md")); } catch {}
    try { await unlink(join(testDir, "soul-telegram.md")); } catch {}
    try { await unlink(join(testDir, "my-soul.md")); } catch {}
    try { await rm(join(testDir, "profiles"), { recursive: true }); } catch {}
  });

  it("loads default soul.md", async () => {
    await writeFile(join(testDir, "soul.md"), "# Identity\nI am a test agent");
    loader = new SoulLoader(testDir);
    await loader.initialize();
    expect(loader.getContent()).toBe("# Identity\nI am a test agent");
  });

  it("returns empty string when soul.md missing", async () => {
    loader = new SoulLoader(testDir);
    await loader.initialize();
    expect(loader.getContent()).toBe("");
  });

  it("returns channel override when available", async () => {
    await writeFile(join(testDir, "soul.md"), "default personality");
    await writeFile(join(testDir, "soul-telegram.md"), "telegram personality");
    loader = new SoulLoader(testDir, {
      channelOverrides: { telegram: "soul-telegram.md" },
    });
    await loader.initialize();
    expect(loader.getContent("telegram")).toBe("telegram personality");
    expect(loader.getContent("web")).toBe("default personality");
    expect(loader.getContent()).toBe("default personality");
  });

  it("falls back to default when channel override missing", async () => {
    await writeFile(join(testDir, "soul.md"), "default personality");
    loader = new SoulLoader(testDir, {
      channelOverrides: { discord: "soul-discord.md" },
    });
    await loader.initialize();
    expect(loader.getContent("discord")).toBe("default personality");
  });

  it("supports custom soul file name", async () => {
    await writeFile(join(testDir, "my-soul.md"), "custom name");
    loader = new SoulLoader(testDir, { soulFile: "my-soul.md" });
    await loader.initialize();
    expect(loader.getContent()).toBe("custom name");
  });

  it("shutdown clears cache and watchers", async () => {
    await writeFile(join(testDir, "soul.md"), "content");
    loader = new SoulLoader(testDir);
    await loader.initialize();
    expect(loader.getContent()).toBe("content");
    loader.shutdown();
    expect(loader.getContent()).toBe("");
  });

  // Security tests
  describe("path traversal protection", () => {
    it("rejects absolute path", async () => {
      loader = new SoulLoader(testDir, { soulFile: "/etc/passwd" });
      await loader.initialize();
      expect(loader.getContent()).toBe("");
    });

    it("rejects .. traversal", async () => {
      loader = new SoulLoader(testDir, { soulFile: "../../etc/passwd" });
      await loader.initialize();
      expect(loader.getContent()).toBe("");
    });

    it("rejects .. in channel override", async () => {
      await writeFile(join(testDir, "soul.md"), "default");
      loader = new SoulLoader(testDir, {
        channelOverrides: { telegram: "../../../etc/passwd" },
      });
      await loader.initialize();
      expect(loader.getContent("telegram")).toBe("default");
    });
  });

  describe("switchProfile", () => {
    it("switches to a profile from profiles/ directory", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      await mkdir(join(testDir, "profiles"), { recursive: true });
      await writeFile(join(testDir, "profiles", "casual.md"), "casual personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();
      expect(loader.getContent()).toBe("default personality");

      const success = await loader.switchProfile("casual");
      expect(success).toBe(true);
      expect(loader.getContent()).toBe("casual personality");
    });

    it("switches back to default profile", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      await mkdir(join(testDir, "profiles"), { recursive: true });
      await writeFile(join(testDir, "profiles", "formal.md"), "formal personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();

      await loader.switchProfile("formal");
      expect(loader.getContent()).toBe("formal personality");

      const success = await loader.switchProfile("default");
      expect(success).toBe(true);
      expect(loader.getContent()).toBe("default personality");
    });

    it("returns false for non-existent profile", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();

      const success = await loader.switchProfile("nonexistent");
      expect(success).toBe(false);
      // Default content should remain unchanged
      expect(loader.getContent()).toBe("default personality");
    });
  });

  describe("getProfileContent", () => {
    it("returns profile content without mutating default cache", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      await mkdir(join(testDir, "profiles"), { recursive: true });
      await writeFile(join(testDir, "profiles", "casual.md"), "casual personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();

      const defaultBefore = loader.getContent();
      const result = await loader.getProfileContent("casual");

      expect(result).toBe("casual personality");
      expect(loader.getContent()).toBe(defaultBefore);
      expect(loader.getContent()).toBe("default personality");
    });

    it("returns null for nonexistent profile", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();

      const result = await loader.getProfileContent("nonexistent");
      expect(result).toBeNull();
    });

    it("rejects invalid profile names (path traversal)", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();

      expect(await loader.getProfileContent("../../../etc/passwd")).toBeNull();
      expect(await loader.getProfileContent("foo/../bar")).toBeNull();
      expect(await loader.getProfileContent("foo/bar")).toBeNull();
      expect(await loader.getProfileContent("has spaces")).toBeNull();
      expect(await loader.getProfileContent("has.dots")).toBeNull();
    });

    it("returns default cache content for 'default' profile name", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      loader = new SoulLoader(testDir);
      await loader.initialize();

      const result = await loader.getProfileContent("default");
      expect(result).toBe("default personality");
      expect(result).toBe(loader.getContent());
    });

    it("returns null when default profile requested but cache is empty", async () => {
      loader = new SoulLoader(testDir);
      // Don't initialize — cache has no "default" key
      const result = await loader.getProfileContent("default");
      expect(result).toBeNull();
    });

    it("rejects profile files exceeding size limit", async () => {
      await writeFile(join(testDir, "soul.md"), "default personality");
      await mkdir(join(testDir, "profiles"), { recursive: true });
      await writeFile(join(testDir, "profiles", "huge.md"), "x".repeat(11 * 1024));
      loader = new SoulLoader(testDir);
      await loader.initialize();

      const result = await loader.getProfileContent("huge");
      expect(result).toBeNull();
    });
  });

  describe("file size limit", () => {
    it("rejects files exceeding 10KB", async () => {
      const bigContent = "x".repeat(11 * 1024); // 11KB
      await writeFile(join(testDir, "soul.md"), bigContent);
      loader = new SoulLoader(testDir);
      await loader.initialize();
      expect(loader.getContent()).toBe(""); // Rejected, falls back to empty
    });

    it("accepts files at exactly 10KB", async () => {
      const content = "x".repeat(10 * 1024); // exactly 10KB
      await writeFile(join(testDir, "soul.md"), content);
      loader = new SoulLoader(testDir);
      await loader.initialize();
      expect(loader.getContent()).toBe(content);
    });
  });
});

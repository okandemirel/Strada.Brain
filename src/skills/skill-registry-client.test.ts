import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchRegistry, fetchRegistry } from "./skill-registry-client.js";
import type { SkillRegistry, RegistryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const fsMock = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
};

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => fsMock.readFile(...args),
  writeFile: (...args: unknown[]) => fsMock.writeFile(...args),
  mkdir: (...args: unknown[]) => fsMock.mkdir(...args),
  stat: (...args: unknown[]) => fsMock.stat(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

beforeEach(() => {
  fsMock.readFile.mockReset();
  fsMock.writeFile.mockReset();
  fsMock.mkdir.mockReset();
  fsMock.stat.mockReset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleRegistry: SkillRegistry = {
  version: 1,
  skills: {
    "unity-shader": {
      repo: "https://github.com/example/unity-shader",
      description: "Shader generation for Unity",
      tags: ["unity", "shader", "graphics"],
      version: "1.0.0",
    },
    "code-review": {
      repo: "https://github.com/example/code-review",
      description: "Automated code review tool",
      tags: ["review", "quality"],
      version: "2.1.0",
    },
    "docker-deploy": {
      repo: "https://github.com/example/docker-deploy",
      description: "Deploy containers via Docker",
      tags: ["docker", "deploy", "devops"],
      version: "0.5.0",
    },
  },
};

// ---------------------------------------------------------------------------
// searchRegistry
// ---------------------------------------------------------------------------

describe("searchRegistry", () => {
  it("should find by name substring", () => {
    const results = searchRegistry(sampleRegistry, "shader");
    expect(results).toHaveLength(1);
    expect(results[0]![0]).toBe("unity-shader");
  });

  it("should find by tag", () => {
    const results = searchRegistry(sampleRegistry, "devops");
    expect(results).toHaveLength(1);
    expect(results[0]![0]).toBe("docker-deploy");
  });

  it("should find by description", () => {
    const results = searchRegistry(sampleRegistry, "automated");
    expect(results).toHaveLength(1);
    expect(results[0]![0]).toBe("code-review");
  });

  it("should be case-insensitive", () => {
    const results = searchRegistry(sampleRegistry, "DOCKER");
    expect(results).toHaveLength(1);
    expect(results[0]![0]).toBe("docker-deploy");
  });

  it("should return empty for no match", () => {
    const results = searchRegistry(sampleRegistry, "nonexistent-xyz");
    expect(results).toHaveLength(0);
  });

  it("should return multiple matches", () => {
    const results = searchRegistry(sampleRegistry, "unity");
    // "unity-shader" name and "unity" tag both match on the same entry
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]![0]).toBe("unity-shader");
  });
});

// ---------------------------------------------------------------------------
// fetchRegistry
// ---------------------------------------------------------------------------

describe("fetchRegistry", () => {
  it("should return cached data when cache is fresh", async () => {
    const cacheJson = JSON.stringify(sampleRegistry);
    fsMock.readFile.mockResolvedValue(cacheJson);
    fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - 1000 }); // 1 second old

    const result = await fetchRegistry();

    expect(result.version).toBe(1);
    expect(Object.keys(result.skills)).toHaveLength(3);
  });

  it("should return empty registry on network failure with no cache", async () => {
    fsMock.readFile.mockRejectedValue(new Error("ENOENT"));
    fsMock.stat.mockRejectedValue(new Error("ENOENT"));

    // Mock global fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    try {
      const result = await fetchRegistry(true);
      expect(result.version).toBe(0);
      expect(Object.keys(result.skills)).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should fallback to stale cache on network failure", async () => {
    const cacheJson = JSON.stringify(sampleRegistry);
    fsMock.readFile.mockResolvedValue(cacheJson);
    fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - 2 * 60 * 60 * 1000 }); // 2 hours old (stale)
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);

    // Mock global fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    try {
      const result = await fetchRegistry(true);
      // Should return the stale cache instead of empty
      expect(result.version).toBe(1);
      expect(Object.keys(result.skills)).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

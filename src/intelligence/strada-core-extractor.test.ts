import { beforeEach, describe, expect, it, vi } from "vitest";
import { StradaCoreExtractor } from "./strada-core-extractor.js";

vi.mock("glob", () => ({
  glob: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  realpath: vi.fn(async (input: string) => input),
}));

import { glob } from "glob";
import { readFile } from "node:fs/promises";

describe("StradaCoreExtractor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts an empty snapshot without requiring logger initialization", async () => {
    vi.mocked(glob).mockResolvedValue([]);

    const extractor = new StradaCoreExtractor("/tmp/Strada.Core");
    const snapshot = await extractor.extract();

    expect(snapshot.fileCount).toBe(0);
    expect(snapshot.classes).toEqual([]);
    expect(snapshot.interfaces).toEqual([]);
    expect(snapshot.namespaces).toEqual([]);
  });

  it("skips unreadable files without throwing when logger is not initialized", async () => {
    vi.mocked(glob).mockResolvedValue(["/tmp/Strada.Core/Runtime/Broken.cs"] as never);
    vi.mocked(readFile).mockRejectedValue(new Error("boom"));

    const extractor = new StradaCoreExtractor("/tmp/Strada.Core");
    const snapshot = await extractor.extract();

    expect(snapshot.fileCount).toBe(0);
    expect(snapshot.classes).toEqual([]);
  });
});

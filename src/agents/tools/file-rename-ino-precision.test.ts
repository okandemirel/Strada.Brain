/**
 * file_rename treats "the destination is the source" (a case-only rename on a
 * case-insensitive disk) as no clash, by dev/ino. A Windows file id is 64
 * bits and read as a plain number it loses precision, so two different files
 * could compare equal and the rename would replace an existing file without
 * overwrite: true. Here stat() without `bigint` answers the same dev/ino for
 * every path, as the rounded ids can.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BigIntStats, StatOptions, Stats } from "node:fs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = async (path: string, options?: StatOptions): Promise<Stats | BigIntStats> => {
    const real = await actual.stat(path, options);
    if (options?.bigint) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as Stats, real, { dev: 1, ino: 1 });
  };
  return { ...actual, stat };
});

const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { FileRenameTool } = await import("./file-manage.js");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "strada-rename-ino-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("file_rename with imprecise file ids", () => {
  it("does not take a different existing file for the source", async () => {
    await writeFile(join(dir, "a.txt"), "source", "utf8");
    await writeFile(join(dir, "b.txt"), "keep me", "utf8");
    const result = await new FileRenameTool().execute(
      { old_path: "a.txt", new_path: "b.txt" },
      { projectPath: dir, workingDirectory: dir, readOnly: false },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("keep me");
  });
});

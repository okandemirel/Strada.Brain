import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only rename is wrapped, so a test can make it fail the way Windows does when
// another process holds the target open.
const renameFaults = vi.hoisted(() => ({ codes: [] as string[] }));

function takeFault(): NodeJS.ErrnoException | null {
  const code = renameFaults.codes.shift();
  if (code === undefined) return null;
  return Object.assign(new Error(`${code}: simulated`), { code });
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const fault = takeFault();
      if (fault) throw fault;
      return actual.rename(from, to);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const fault = takeFault();
      if (fault) throw fault;
      return actual.renameSync(from, to);
    },
  };
});

import {
  corruptFilePath,
  moveAsideCorruptFile,
  moveAsideCorruptFileSync,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./atomic-file.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "strada-atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  renameFaults.codes = [];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces the target and leaves no temp file", async () => {
    const dir = tempDir();
    const target = join(dir, "data.json");
    writeFileSync(target, "old");
    await writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf-8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["data.json"]);
  });

  it("gives concurrent writers their own temp files, so the result is one whole payload", async () => {
    const dir = tempDir();
    const target = join(dir, "graph.canvas");
    const payloads = Array.from({ length: 8 }, (_, i) => JSON.stringify({ writer: i, fill: "x".repeat(600_000) }));
    await Promise.all(payloads.map((p) => writeFileAtomic(target, p)));
    expect(payloads).toContain(readFileSync(target, "utf-8"));
    expect(readdirSync(dir)).toEqual(["graph.canvas"]);
  });

  it("retries a rename that fails transiently (Windows EPERM/EBUSY)", async () => {
    const dir = tempDir();
    const target = join(dir, "memory.json");
    renameFaults.codes = ["EPERM", "EBUSY", "EACCES"];
    await writeFileAtomic(target, "saved");
    expect(readFileSync(target, "utf-8")).toBe("saved");
    expect(renameFaults.codes).toEqual([]);
  });

  it("gives up on a persistent failure, keeps the old file and removes its temp file", async () => {
    const dir = tempDir();
    const target = join(dir, "memory.json");
    writeFileSync(target, "old");
    renameFaults.codes = ["EXDEV"];
    await expect(writeFileAtomic(target, "new")).rejects.toMatchObject({ code: "EXDEV" });
    expect(readFileSync(target, "utf-8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["memory.json"]);
  });
});

describe("writeFileAtomicSync", () => {
  it("writes binary data, retrying a transient rename failure", () => {
    const dir = tempDir();
    const target = join(dir, "vectors.bin");
    renameFaults.codes = ["EBUSY"];
    writeFileAtomicSync(target, new Uint8Array([1, 2, 3, 4]));
    expect([...readFileSync(target)]).toEqual([1, 2, 3, 4]);
    expect(readdirSync(dir)).toEqual(["vectors.bin"]);
  });
});

describe("moveAsideCorruptFile", () => {
  it("renames the file to <path>.corrupt-<timestamp> with no ':' in the name", async () => {
    const dir = tempDir();
    const target = join(dir, "memory.json");
    writeFileSync(target, "{trunc");
    const aside = await moveAsideCorruptFile(target);
    expect(aside).not.toBeNull();
    expect(aside!.startsWith(`${target}.corrupt-`)).toBe(true);
    expect(aside!.slice(dir.length)).not.toContain(":");
    expect(readFileSync(aside!, "utf-8")).toBe("{trunc");
  });

  it("returns null when the file cannot be moved (sync variant too)", async () => {
    const dir = tempDir();
    expect(await moveAsideCorruptFile(join(dir, "missing.json"))).toBeNull();
    expect(moveAsideCorruptFileSync(join(dir, "missing.json"))).toBeNull();
  });

  it("formats the timestamp predictably", () => {
    expect(corruptFilePath("/x/memory.json", new Date("2026-09-25T10:11:12.345Z")))
      .toBe("/x/memory.json.corrupt-2026-09-25T10-11-12-345Z");
  });
});

import { describe, it, expect } from "vitest";
import { validateSafeVaultWriteRelPath, isIgnoredVaultPath } from "./path-policy.js";

describe("validateSafeVaultWriteRelPath traversal guard", () => {
  it("rejects ../ parent traversal (REST write path no longer escapes the vault)", () => {
    expect(() => validateSafeVaultWriteRelPath("../../etc/passwd.md", 10)).toThrow(/escapes vault root/);
  });

  it("rejects an embedded .. segment", () => {
    expect(() => validateSafeVaultWriteRelPath("Notes/../../secret.md", 10)).toThrow(/escapes vault root/);
  });

  it("rejects backslash-style traversal", () => {
    expect(() => validateSafeVaultWriteRelPath("..\\..\\x.md", 10)).toThrow(/escapes vault root/);
  });

  it("rejects absolute paths", () => {
    expect(() => validateSafeVaultWriteRelPath("/etc/passwd.md", 10)).toThrow(/escapes vault root/);
  });

  it("accepts a normal vault-relative note path", () => {
    expect(validateSafeVaultWriteRelPath("Notes/My Note.md", 10)).toBe("Notes/My Note.md");
  });
});

describe("isIgnoredVaultPath — exact-segment matching (lock-in: not a substring match)", () => {
  it("ignores bin/obj/Library/etc. only as full path segments", () => {
    expect(isIgnoredVaultPath("Assets/bin/Foo.cs")).toBe(true);
    expect(isIgnoredVaultPath("Assets/obj/Foo.cs")).toBe(true);
    expect(isIgnoredVaultPath("Library/x.cs")).toBe(true);
    expect(isIgnoredVaultPath("node_modules/x/y.js")).toBe(true);
    expect(isIgnoredVaultPath(".git/config")).toBe(true);
  });

  it("does NOT ignore directories that merely contain bin/obj as a substring", () => {
    for (const p of [
      "Assets/binary/Foo.cs", "Assets/cabinet/Foo.cs", "Assets/object/Foo.cs",
      "Assets/objective/Foo.cs", "src/Robin/Foo.cs", "foobin/Foo.cs", "binfoo/Foo.cs",
    ]) {
      expect(isIgnoredVaultPath(p)).toBe(false);
    }
  });

  it("matches segments across Windows backslash separators too", () => {
    expect(isIgnoredVaultPath("Assets\\bin\\Foo.cs")).toBe(true);
    expect(isIgnoredVaultPath("Assets\\binary\\Foo.cs")).toBe(false);
  });
});

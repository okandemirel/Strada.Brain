import { describe, it, expect } from "vitest";
import { validateSafeVaultWriteRelPath } from "./path-policy.js";

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

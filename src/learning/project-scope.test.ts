import { describe, expect, it } from "vitest";
import { projectScopeMatches } from "./project-scope.js";

describe("projectScopeMatches", () => {
  it("returns true when both fingerprints are identical", () => {
    expect(projectScopeMatches("root=/home/user/project", "root=/home/user/project")).toBe(true);
  });

  it("returns true when artifactFingerprint starts with runtimeFingerprint (child scope)", () => {
    expect(projectScopeMatches("root=/home/user/project/sub", "root=/home/user/project")).toBe(true);
  });

  it("returns true when runtimeFingerprint starts with artifactFingerprint (parent scope)", () => {
    expect(projectScopeMatches("root=/home/user/project", "root=/home/user/project/sub")).toBe(true);
  });

  it("returns false when fingerprints are completely different", () => {
    expect(projectScopeMatches("root=/home/user/alpha", "root=/home/user/beta")).toBe(false);
  });

  it("returns false when artifactFingerprint is null", () => {
    expect(projectScopeMatches(null, "root=/home/user/project")).toBe(false);
  });

  it("returns false when runtimeFingerprint is null", () => {
    expect(projectScopeMatches("root=/home/user/project", null)).toBe(false);
  });

  it("returns false when artifactFingerprint is undefined", () => {
    expect(projectScopeMatches(undefined, "root=/home/user/project")).toBe(false);
  });

  it("returns false when runtimeFingerprint is undefined", () => {
    expect(projectScopeMatches("root=/home/user/project", undefined)).toBe(false);
  });

  it("returns false when both are null", () => {
    expect(projectScopeMatches(null, null)).toBe(false);
  });

  it("returns false when both are undefined", () => {
    expect(projectScopeMatches(undefined, undefined)).toBe(false);
  });

  it("returns false when artifactFingerprint is an empty string", () => {
    expect(projectScopeMatches("", "root=/home/user/project")).toBe(false);
  });

  it("returns false when runtimeFingerprint is an empty string", () => {
    expect(projectScopeMatches("root=/home/user/project", "")).toBe(false);
  });

  it("returns false when artifactFingerprint is whitespace only", () => {
    expect(projectScopeMatches("   ", "root=/home/user/project")).toBe(false);
  });

  it("trims whitespace before comparing", () => {
    expect(projectScopeMatches("  root=/home/user/project  ", "root=/home/user/project")).toBe(true);
  });
});

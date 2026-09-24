import { describe, expect, it } from "vitest";
import { projectScopeMatches } from "./project-scope.js";
import { createProjectScopeFingerprint } from "./runtime-artifact-manager.js";

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

// LRN-16: a raw string prefix made a project a "parent scope" of every sibling
// whose name merely starts with its own.
describe("projectScopeMatches respects name boundaries (LRN-16)", () => {
  it("a sibling project whose name extends this one's is not the same scope", () => {
    expect(projectScopeMatches("root=/a/Tower", "root=/a/TowerDefense")).toBe(false);
    expect(projectScopeMatches("root=/a/TowerDefense", "root=/a/Tower")).toBe(false);
    expect(projectScopeMatches("root=/a/my", "root=/a/my_game")).toBe(false);
  });

  it("normalized fingerprints keep their parent/child and exact matches", () => {
    const tower = createProjectScopeFingerprint("/work/Tower")!;
    const towerDefense = createProjectScopeFingerprint("/work/TowerDefense")!;
    expect(projectScopeMatches(tower, `${towerDefense} analysis unavailable`)).toBe(false);
    expect(projectScopeMatches(tower, `${tower} analysis unavailable`)).toBe(true);
    expect(projectScopeMatches(tower, tower)).toBe(true);
    expect(projectScopeMatches("root=/a/", "root=/a/b")).toBe(true);
  });
});

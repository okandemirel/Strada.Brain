import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import { isAtOrInside, isStrictlyInside } from "./path-containment.js";

describe("path containment — the one answer", () => {
  it("counts the root itself as at-or-inside, and not as strictly inside", () => {
    expect(isAtOrInside("/p", "/p", posix)).toBe(true);
    expect(isStrictlyInside("/p", "/p", posix)).toBe(false);
    expect(isAtOrInside("/p", "/p/", posix)).toBe(true);
  });

  it("accepts a path below the root", () => {
    expect(isAtOrInside("/p", "/p/a/b.cs", posix)).toBe(true);
    expect(isStrictlyInside("/p", "/p/a/b.cs", posix)).toBe(true);
  });

  it("refuses a sibling that merely shares the root's prefix", () => {
    // The string-prefix copies needed `root + sep` to get this right, and one
    // of them broke on "/" because "/" + sep is "//".
    expect(isAtOrInside("/p", "/pp/a", posix)).toBe(false);
    expect(isAtOrInside("/p", "/p-old", posix)).toBe(false);
  });

  it("refuses a climb, including one hidden in a non-normalised path", () => {
    expect(isAtOrInside("/p", "/p/../q", posix)).toBe(false);
    expect(isAtOrInside("/p", "/", posix)).toBe(false);
    expect(isAtOrInside("/p/a", "/p", posix)).toBe(false);
  });

  it("accepts a child whose name merely begins with two dots", () => {
    // `rel.startsWith("..")` called this an escape: a file honestly named
    // `..cache` is inside.
    expect(isAtOrInside("/p", "/p/..cache", posix)).toBe(true);
    expect(isStrictlyInside("/p", "/p/..cache/x", posix)).toBe(true);
  });

  it("works with the filesystem root as the root", () => {
    expect(isAtOrInside("/", "/anything", posix)).toBe(true);
    expect(isStrictlyInside("/", "/", posix)).toBe(false);
    expect(isAtOrInside("C:\\", "C:\\Users\\x", win32)).toBe(true);
  });

  it("judges Windows paths by Windows rules: case, both separators, another drive", () => {
    expect(isAtOrInside("C:\\Proj", "c:\\proj\\Assets\\a.cs", win32)).toBe(true);
    expect(isAtOrInside("C:\\Proj", "C:/Proj/Assets/a.cs", win32)).toBe(true);
    expect(isAtOrInside("C:\\Proj", "D:\\Proj\\a.cs", win32)).toBe(false);
    expect(isAtOrInside("C:\\Proj", "C:\\Proj2\\a.cs", win32)).toBe(false);
  });
});

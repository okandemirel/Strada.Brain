/**
 * Widening a security boundary, so the tests are written from the attacker's
 * side: what must this NOT allow.
 */

import { describe, it, expect } from "vitest";
import { extractUserAuthorizedPaths, isUserAuthorizedPath } from "./user-authorized-paths.js";

describe("what the user asked to be read", () => {
  it("takes the path out of an ordinary sentence", () => {
    expect(extractUserAuthorizedPaths("Read the design at /Users/o/Desktop/gdd.md and build it"))
      .toEqual(["/Users/o/Desktop/gdd.md"]);
  });

  it("does not swallow the full stop that ends the sentence", () => {
    expect(extractUserAuthorizedPaths("Build what is in /docs/spec.md.")).toEqual(["/docs/spec.md"]);
  });

  it("takes several, and each only once", () => {
    const found = extractUserAuthorizedPaths("Compare /a/one.md with /b/two.md, then /a/one.md again");

    expect(found.sort()).toEqual(["/a/one.md", "/b/two.md"]);
  });

  it("finds a quoted path", () => {
    expect(extractUserAuthorizedPaths('read "/a/my file.md"')).toContain("/a/my");
  });

  it("finds nothing in a message with no path", () => {
    expect(extractUserAuthorizedPaths("build me a match-3 game")).toEqual([]);
    expect(extractUserAuthorizedPaths("")).toEqual([]);
  });

  it("ignores a bare slash", () => {
    expect(extractUserAuthorizedPaths("use / as the separator")).toEqual([]);
  });
});

describe("what the authorization does not extend to", () => {
  const authorized = extractUserAuthorizedPaths("read /Users/o/Desktop/gdd.md");

  it("allows exactly the named file", () => {
    expect(isUserAuthorizedPath("/Users/o/Desktop/gdd.md", authorized)).toBe(true);
  });

  it("refuses a sibling in the same directory", () => {
    // Naming one file is not naming its folder.
    expect(isUserAuthorizedPath("/Users/o/Desktop/secrets.txt", authorized)).toBe(false);
  });

  it("refuses the directory that contains it", () => {
    expect(isUserAuthorizedPath("/Users/o/Desktop", authorized)).toBe(false);
  });

  it("refuses a traversal that resolves elsewhere", () => {
    // Prefix matching would have let this through.
    expect(isUserAuthorizedPath("/Users/o/Desktop/gdd.md/../../.ssh/id_rsa", authorized)).toBe(false);
    expect(isUserAuthorizedPath("/Users/o/Desktop/../../../etc/passwd", authorized)).toBe(false);
  });

  it("refuses a path that merely starts with the same characters", () => {
    expect(isUserAuthorizedPath("/Users/o/Desktop/gdd.md.bak", authorized)).toBe(false);
  });

  it("refuses everything when the user named nothing", () => {
    expect(isUserAuthorizedPath("/etc/passwd", [])).toBe(false);
    expect(isUserAuthorizedPath("/etc/passwd", undefined)).toBe(false);
  });

  it("matches an equivalent spelling of the same file", () => {
    // Same file, written with a redundant segment: still the file they named.
    expect(isUserAuthorizedPath("/Users/o/Desktop/./gdd.md", authorized)).toBe(true);
  });
});

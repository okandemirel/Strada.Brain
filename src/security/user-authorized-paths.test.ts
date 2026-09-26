/**
 * Widening a security boundary, so the tests are written from the attacker's
 * side: what must this NOT allow.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  extractUserAuthorizedPaths,
  isUserAuthorizedPath,
  MAX_AUTHORIZED_CHATS,
  MAX_AUTHORIZED_PATHS_PER_CHAT,
  rememberUserAuthorizedPaths,
} from "./user-authorized-paths.js";

// Paths come back resolved: on Windows a rooted "/a/b" is on the current drive.
describe("what the user asked to be read", () => {
  it("takes the path out of an ordinary sentence", () => {
    expect(extractUserAuthorizedPaths("Read the design at /Users/o/Desktop/gdd.md and build it"))
      .toEqual([resolve("/Users/o/Desktop/gdd.md")]);
  });

  it("does not swallow the full stop that ends the sentence", () => {
    expect(extractUserAuthorizedPaths("Build what is in /docs/spec.md.")).toEqual([resolve("/docs/spec.md")]);
  });

  it("takes several, and each only once", () => {
    const found = extractUserAuthorizedPaths("Compare /a/one.md with /b/two.md, then /a/one.md again");

    expect(found.sort()).toEqual([resolve("/a/one.md"), resolve("/b/two.md")]);
  });

  it("finds a quoted path", () => {
    expect(extractUserAuthorizedPaths('read "/a/my file.md"')).toContain(resolve("/a/my"));
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

describe("the store the authorization is kept in stays bounded", () => {
  it("adds to a chat's paths without duplicating them", () => {
    const store = new Map<string, readonly string[]>();
    rememberUserAuthorizedPaths(store, "chat", ["/a.md"]);
    rememberUserAuthorizedPaths(store, "chat", ["/a.md", "/b.md"]);

    expect(store.get("chat")).toEqual(["/a.md", "/b.md"]);
  });

  it("writes nothing for a message that named nothing", () => {
    const store = new Map<string, readonly string[]>();
    rememberUserAuthorizedPaths(store, "chat", []);

    expect(store.has("chat")).toBe(false);
  });

  it("keeps a bounded number of chats, dropping the least recently written", () => {
    const store = new Map<string, readonly string[]>();
    for (let i = 0; i <= MAX_AUTHORIZED_CHATS + 10; i++) {
      rememberUserAuthorizedPaths(store, `chat-${i}`, [`/f${i}.md`]);
      if (i === MAX_AUTHORIZED_CHATS - 6) rememberUserAuthorizedPaths(store, "chat-0", ["/again.md"]);
    }

    expect(store.size).toBe(MAX_AUTHORIZED_CHATS);
    expect(store.has("chat-1")).toBe(false);
    // Written again late, so it outlived the chats written after it first was.
    expect(store.has("chat-0")).toBe(true);
    expect(store.has(`chat-${MAX_AUTHORIZED_CHATS + 10}`)).toBe(true);
  });

  it("keeps a bounded number of paths per chat, dropping the oldest", () => {
    const store = new Map<string, readonly string[]>();
    const many = Array.from({ length: MAX_AUTHORIZED_PATHS_PER_CHAT + 5 }, (_, i) => `/p${i}.md`);
    rememberUserAuthorizedPaths(store, "chat", many);

    expect(store.get("chat")).toHaveLength(MAX_AUTHORIZED_PATHS_PER_CHAT);
    expect(store.get("chat")).not.toContain("/p0.md");
    expect(store.get("chat")).toContain(`/p${MAX_AUTHORIZED_PATHS_PER_CHAT + 4}.md`);
  });
});

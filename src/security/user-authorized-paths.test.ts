/**
 * Widening a security boundary, so the tests are written from the attacker's
 * side: what must this NOT allow.
 */

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    expect(extractUserAuthorizedPaths("Read the design at /srv/briefs/brief.md and build it"))
      .toEqual([resolve("/srv/briefs/brief.md")]);
  });

  it("does not swallow the full stop that ends the sentence", () => {
    expect(extractUserAuthorizedPaths("Build what is in /docs/spec.md.")).toEqual([resolve("/docs/spec.md")]);
  });

  it("takes several, and each only once", () => {
    const found = extractUserAuthorizedPaths("Compare /a/one.md with /b/two.md, then /a/one.md again");

    expect(found.sort()).toEqual([resolve("/a/one.md"), resolve("/b/two.md")]);
  });

  it("finds a quoted path, spaces and all, and not the fragment before the first space", () => {
    // This test used to assert the fragment "/a/my": the pattern stopped at
    // the first space even inside quotes, so the file the user named was never
    // authorized and a different one was (audit security-config#3).
    expect(extractUserAuthorizedPaths('read "/a/my file.md"')).toEqual([resolve("/a/my file.md")]);
    expect(extractUserAuthorizedPaths("read '/a/my file.md' please")).toEqual([resolve("/a/my file.md")]);
    expect(extractUserAuthorizedPaths("read `/a/my file.md`")).toEqual([resolve("/a/my file.md")]);
  });

  it("authorizes the design document a user names with spaces in it", () => {
    const authorized = extractUserAuthorizedPaths('Read "/srv/briefs/Orchard Survey Brief.docx" and build that game.');

    expect(isUserAuthorizedPath("/srv/briefs/Orchard Survey Brief.docx", authorized)).toBe(true);
    expect(isUserAuthorizedPath("/srv/briefs/Orchard", authorized)).toBe(false);
  });

  it("takes an iCloud Drive path whole", () => {
    expect(extractUserAuthorizedPaths('the spec is in "/Users/o/Library/Mobile Documents/com~apple~CloudDocs/GDD.md".'))
      .toEqual([resolve("/Users/o/Library/Mobile Documents/com~apple~CloudDocs/GDD.md")]);
  });

  it("reads a path dragged into a terminal, with its spaces escaped", () => {
    expect(extractUserAuthorizedPaths("read /srv/briefs/Orchard\\ Survey\\ Brief\\ \\(v2\\).docx and build it"))
      .toEqual([resolve("/srv/briefs/Orchard Survey Brief (v2).docx")]);
  });

  it("expands a path written from the home directory", () => {
    expect(extractUserAuthorizedPaths("read ~/briefs/brief.md")).toEqual([join(homedir(), "briefs", "brief.md")]);
    expect(extractUserAuthorizedPaths('read "~/briefs/My Brief.md"')).toEqual([join(homedir(), "briefs", "My Brief.md")]);
    // ~user is another account's home; it is not expanded or authorized.
    expect(extractUserAuthorizedPaths("read ~bob/brief.md")).toEqual([]);
  });

  it("takes a file URL as the path it names", () => {
    const named = resolve("/srv/briefs/My Brief.docx");
    expect(extractUserAuthorizedPaths(`open ${pathToFileURL(named).href} please`)).toEqual([named]);
  });

  it("is not thrown off by apostrophes or by quoted words that are not paths", () => {
    expect(extractUserAuthorizedPaths("it's the user's doc at /a/b.md, isn't it")).toEqual([resolve("/a/b.md")]);
    expect(extractUserAuthorizedPaths('call the project "Fern Brook" and read /a/b.md')).toEqual([resolve("/a/b.md")]);
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
  const authorized = extractUserAuthorizedPaths("read /srv/briefs/brief.md");

  it("allows exactly the named file", () => {
    expect(isUserAuthorizedPath("/srv/briefs/brief.md", authorized)).toBe(true);
  });

  it("refuses a sibling in the same directory", () => {
    // Naming one file is not naming its folder.
    expect(isUserAuthorizedPath("/srv/briefs/secrets.txt", authorized)).toBe(false);
  });

  it("refuses the directory that contains it", () => {
    expect(isUserAuthorizedPath("/srv/briefs", authorized)).toBe(false);
  });

  it("refuses a traversal that resolves elsewhere", () => {
    // Prefix matching would have let this through.
    expect(isUserAuthorizedPath("/srv/briefs/brief.md/../../.ssh/id_rsa", authorized)).toBe(false);
    expect(isUserAuthorizedPath("/srv/briefs/../../../etc/passwd", authorized)).toBe(false);
  });

  it("refuses a path that merely starts with the same characters", () => {
    expect(isUserAuthorizedPath("/srv/briefs/brief.md.bak", authorized)).toBe(false);
  });

  it("refuses everything when the user named nothing", () => {
    expect(isUserAuthorizedPath("/etc/passwd", [])).toBe(false);
    expect(isUserAuthorizedPath("/etc/passwd", undefined)).toBe(false);
  });

  it("matches an equivalent spelling of the same file", () => {
    // Same file, written with a redundant segment: still the file they named.
    expect(isUserAuthorizedPath("/srv/briefs/./brief.md", authorized)).toBe(true);
  });

  it("reads ~ the way the user meant it, and only for the file they named", () => {
    const fromHome = extractUserAuthorizedPaths("read ~/briefs/brief.md");

    expect(isUserAuthorizedPath("~/briefs/brief.md", fromHome)).toBe(true);
    expect(isUserAuthorizedPath(join(homedir(), "briefs", "brief.md"), fromHome)).toBe(true);
    expect(isUserAuthorizedPath("~/briefs/other.md", fromHome)).toBe(false);
    expect(isUserAuthorizedPath("~/briefs/brief.md/../../.ssh/id_rsa", fromHome)).toBe(false);
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

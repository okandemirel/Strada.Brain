/**
 * Tests for the shared retrieval filter layer.
 *
 * Plan 0-B.9 (audit 05.cap + Codex #18) / 3.9 (3.11: 05.cap / 13F4 / D66):
 * one filter for the vector path, the TF-IDF fallback and the file backend;
 * identity scope; project knowledge excluded from personal recall.
 */

import { describe, it, expect } from "vitest";
import {
  matchesRetrievalFilters,
  matchesScope,
  toRetrievalFilters,
  hasActiveFilters,
  UNSCOPED_CHAT_ID,
} from "./retrieval-filters.js";
import type { FilterableEntry } from "./retrieval-filters.js";

function entry(overrides: Partial<FilterableEntry> = {}): FilterableEntry {
  return {
    type: "note",
    tags: [],
    importance: "medium",
    archived: false,
    createdAt: 1_000,
    chatId: UNSCOPED_CHAT_ID,
    tier: "persistent",
    importanceScore: 0.5,
    metadata: {},
    ...overrides,
  };
}

describe("toRetrievalFilters (plan 0-B.9)", () => {
  it("reads chatId from mode:'chat' options and types from mode:'type' options", () => {
    expect(toRetrievalFilters({ mode: "chat", chatId: "A" as never }).chatId).toBe("A");
    expect(toRetrievalFilters({ mode: "type", types: ["note", "task"] }).types).toEqual(["note", "task"]);
  });

  it("reads the flat UnifiedMemoryQuery fields (chatId/type/tier/domain/minImportance/scope)", () => {
    const f = toRetrievalFilters({
      chatId: "A",
      type: "task",
      tier: "working",
      domain: "d",
      minImportance: 0.4,
      scope: { userId: "u1" },
    });
    expect(f).toMatchObject({
      chatId: "A",
      type: "task",
      tier: "working",
      domain: "d",
      minImportance: 0.4,
      scope: { userId: "u1" },
    });
    expect(hasActiveFilters(f)).toBe(true);
    expect(hasActiveFilters(toRetrievalFilters({ mode: "text", query: "q" }))).toBe(false);
  });
});

describe("matchesRetrievalFilters — one layer for every path (plan 0-B.9)", () => {
  it("applies chatId / type / tier / domain exactly as the vector path did", () => {
    const e = entry({ chatId: "A", type: "task", tier: "working", domain: "unity" });
    expect(matchesRetrievalFilters(e, { chatId: "A" })).toBe(true);
    expect(matchesRetrievalFilters(e, { chatId: "B" })).toBe(false);
    expect(matchesRetrievalFilters(e, { type: "task" })).toBe(true);
    expect(matchesRetrievalFilters(e, { type: "note" })).toBe(false);
    expect(matchesRetrievalFilters(e, { types: ["note", "task"] })).toBe(true);
    expect(matchesRetrievalFilters(e, { types: ["note"] })).toBe(false);
    expect(matchesRetrievalFilters(e, { tier: "working" })).toBe(true);
    expect(matchesRetrievalFilters(e, { tier: "persistent" })).toBe(false);
    expect(matchesRetrievalFilters(e, { domain: "unity" })).toBe(true);
    expect(matchesRetrievalFilters(e, { domain: "web" })).toBe(false);
  });

  it("applies minImportance, expiry, tags, importance, archived and time range", () => {
    const e = entry({ tags: ["a", "b"], importance: "high", createdAt: 500, expiresAt: 900 });
    expect(matchesRetrievalFilters(e, { minImportance: 0.5 }, 100)).toBe(true);
    expect(matchesRetrievalFilters(e, { minImportance: 0.9 }, 100)).toBe(false);
    expect(matchesRetrievalFilters(e, {}, 1_000)).toBe(false); // expired
    expect(matchesRetrievalFilters(e, { includeExpired: true }, 1_000)).toBe(true);
    expect(matchesRetrievalFilters(e, { tags: ["a"] }, 100)).toBe(true);
    expect(matchesRetrievalFilters(e, { tags: ["a", "z"] }, 100)).toBe(false);
    expect(matchesRetrievalFilters(e, { importance: ["high"] }, 100)).toBe(true);
    expect(matchesRetrievalFilters(e, { importance: ["low"] }, 100)).toBe(false);
    expect(matchesRetrievalFilters(entry({ archived: true }), { includeArchived: false })).toBe(false);
    expect(matchesRetrievalFilters(entry({ archived: true }), {})).toBe(true);
    expect(matchesRetrievalFilters(e, { after: 600 }, 100)).toBe(false);
    expect(matchesRetrievalFilters(e, { before: 400 }, 100)).toBe(false);
    expect(matchesRetrievalFilters(e, { after: 400, before: 600 }, 100)).toBe(true);
  });
});

describe("identity scope (plan 3.9)", () => {
  it("excludes entries carrying a different chatId / userId / projectId", () => {
    const a = entry({ chatId: "A", userId: "u1", projectId: "p1" });
    expect(matchesScope(a, { chatId: "A" as never })).toBe(true);
    expect(matchesScope(a, { chatId: "B" as never })).toBe(false);
    expect(matchesScope(a, { userId: "u1" })).toBe(true);
    expect(matchesScope(a, { userId: "u2" })).toBe(false);
    expect(matchesScope(a, { projectId: "p1" })).toBe(true);
    expect(matchesScope(a, { projectId: "p2" })).toBe(false);
  });

  it("keeps entries with no userId/projectId and reads identity from metadata", () => {
    const noIdentity = entry({ chatId: "A" });
    expect(matchesScope(noIdentity, { chatId: "A" as never, userId: "u1", projectId: "p1" })).toBe(true);
    const viaMeta = entry({ metadata: { userId: "u2" } });
    expect(matchesScope(viaMeta, { userId: "u1" })).toBe(false);
    expect(matchesScope(viaMeta, { userId: "u2" })).toBe(true);
  });

  it("no scope keeps today's behaviour", () => {
    expect(matchesScope(entry({ chatId: "A", userId: "u9" }), undefined)).toBe(true);
  });
});

// Codex adversarial review 2026-09-17 round 6 #16: chatId "default" (unknown
// ownership) was treated as SHARED and returned to every scoped chat.
describe("unowned vs explicitly shared entries (Codex round 6 #16)", () => {
  const unowned = entry({ chatId: UNSCOPED_CHAT_ID });
  const missing = entry({ chatId: undefined });

  it("an entry with chatId 'default' or missing is NOT returned to a scoped chat", () => {
    expect(matchesScope(unowned, { chatId: "A" as never })).toBe(false);
    expect(matchesScope(missing, { chatId: "A" as never })).toBe(false);
    expect(matchesRetrievalFilters(unowned, { scope: { chatId: "A" as never } })).toBe(false);
  });

  it("it is returned when no scope is given, when the scope names no chat, or when the scope's chatId is 'default'", () => {
    expect(matchesScope(unowned, undefined)).toBe(true);
    expect(matchesScope(unowned, { userId: "u1" })).toBe(true);
    expect(matchesScope(unowned, { chatId: UNSCOPED_CHAT_ID as never })).toBe(true);
    expect(matchesScope(missing, { chatId: UNSCOPED_CHAT_ID as never })).toBe(true);
  });

  it("an explicitly shared entry (shared: true or metadata.shared) crosses chats", () => {
    expect(matchesScope(entry({ chatId: UNSCOPED_CHAT_ID, shared: true }), { chatId: "A" as never })).toBe(true);
    expect(matchesScope(entry({ chatId: undefined, metadata: { shared: true } }), { chatId: "A" as never })).toBe(true);
    expect(matchesScope(entry({ chatId: "B", shared: true }), { chatId: "A" as never })).toBe(true);
    // a non-boolean marker is not a share
    expect(matchesScope(entry({ chatId: UNSCOPED_CHAT_ID, metadata: { shared: "yes" } }), { chatId: "A" as never })).toBe(false);
  });

  it("an owned entry still matches its own chat and no other", () => {
    expect(matchesScope(entry({ chatId: "A" }), { chatId: "A" as never })).toBe(true);
    expect(matchesScope(entry({ chatId: "A" }), { chatId: "B" as never })).toBe(false);
  });
});

describe("project knowledge is not personal recall (plan 3.9)", () => {
  const project = entry({ type: "project", projectId: "p1" });

  it("is excluded from an unfiltered or personally-scoped retrieval", () => {
    expect(matchesRetrievalFilters(project, {})).toBe(false);
    expect(matchesRetrievalFilters(project, { scope: { userId: "u1", chatId: "A" as never } })).toBe(false);
  });

  it("is returned when asked for by type or when the scope names its project", () => {
    expect(matchesRetrievalFilters(project, { type: "project" })).toBe(true);
    expect(matchesRetrievalFilters(project, { types: ["project"] })).toBe(true);
    expect(matchesRetrievalFilters(project, { scope: { projectId: "p1" } })).toBe(true);
    expect(matchesRetrievalFilters(project, { scope: { projectId: "p2" } })).toBe(false);
  });
});

// Codex adversarial review 2026-09-17 round 7 #18: `shared: true` bypassed the
// user and project comparisons, not only chat ownership — an Alice/project-A
// note matched Bob/project-B.
describe("a share crosses chats only (Codex round 7 #18)", () => {
  const aliceProjectA = entry({ chatId: "A", userId: "alice", projectId: "project-A", shared: true });

  it("a shared note with a different userId is excluded from that user's scope", () => {
    expect(matchesScope(aliceProjectA, { userId: "bob" })).toBe(false);
    expect(matchesScope(aliceProjectA, { userId: "bob", chatId: "B" as never })).toBe(false);
    expect(matchesRetrievalFilters(aliceProjectA, { scope: { userId: "bob", chatId: "B" as never } })).toBe(false);
  });

  it("a shared note with a different projectId is excluded from that project's scope", () => {
    expect(matchesScope(aliceProjectA, { projectId: "project-B" })).toBe(false);
    expect(matchesRetrievalFilters(aliceProjectA, { scope: { chatId: "B" as never, projectId: "project-B" } })).toBe(false);
    // metadata-supplied identity is compared the same way
    const viaMeta = entry({ chatId: "A", shared: true, metadata: { userId: "alice", shared: true } });
    expect(matchesScope(viaMeta, { userId: "bob", chatId: "B" as never })).toBe(false);
  });

  it("the share still bypasses the chat comparison for the same user and project", () => {
    expect(matchesScope(aliceProjectA, { userId: "alice", projectId: "project-A", chatId: "B" as never })).toBe(true);
    expect(matchesScope(aliceProjectA, { chatId: "B" as never })).toBe(true);
    // an entry carrying no user is not a mismatch for a user scope (plan 3.9)
    expect(matchesScope(entry({ chatId: "A", shared: true }), { userId: "bob", chatId: "B" as never })).toBe(true);
  });
});

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

  it("keeps shared entries (no identity / default chat) and reads identity from metadata", () => {
    const shared = entry({ chatId: UNSCOPED_CHAT_ID });
    expect(matchesScope(shared, { chatId: "A" as never, userId: "u1", projectId: "p1" })).toBe(true);
    const viaMeta = entry({ metadata: { userId: "u2" } });
    expect(matchesScope(viaMeta, { userId: "u1" })).toBe(false);
    expect(matchesScope(viaMeta, { userId: "u2" })).toBe(true);
  });

  it("no scope keeps today's behaviour", () => {
    expect(matchesScope(entry({ chatId: "A", userId: "u9" }), undefined)).toBe(true);
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

/**
 * DigestFormatter Tests
 *
 * Tests for formatDigest() markdown rendering, section auto-detection,
 * channel-aware truncation, and delta display.
 */

import { describe, it, expect } from "vitest";
import {
  formatDigest,
  truncateForChannel,
  type DigestSnapshot,
  type DigestDeltas,
} from "./digest-formatter.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeSnapshot(overrides?: Partial<DigestSnapshot>): DigestSnapshot {
  return {
    errors: [],
    triggers: [],
    tasksCompleted: 0,
    tasksFailed: 0,
    instinctsLearned: 0,
    instinctsPromoted: 0,
    totalActiveInstincts: 0,
    budgetUsed: null,
    budgetLimit: null,
    goalProgress: null,
    dashboardUrl: "http://localhost:3100",
    ...overrides,
  };
}

function makeDeltas(overrides?: Partial<DigestDeltas>): DigestDeltas {
  return {
    ...overrides,
  };
}

// =============================================================================
// formatDigest
// =============================================================================

describe("formatDigest", () => {
  it("produces markdown with TL;DR, errors, triggers, tasks, learning, budget, and dashboard link", () => {
    const snapshot = makeSnapshot({
      errors: [
        { message: 'Task "analyze Unity logs" failed (timeout)', timestamp: Date.now() },
      ],
      triggers: [
        { name: "Watch Unity scripts", fireCount: 4, lastResult: "success" },
        { name: "Daily backup", fireCount: 1, lastResult: "success" },
      ],
      tasksCompleted: 3,
      tasksFailed: 1,
      instinctsLearned: 2,
      instinctsPromoted: 1,
      totalActiveInstincts: 12,
      budgetUsed: 2.1,
      budgetLimit: 5.0,
      goalProgress: { active: 1, completed: 2, failed: 0 },
    });
    const deltas = makeDeltas({
      taskDelta: 2,
      instinctDelta: 3,
      budgetDelta: 0.85,
    });

    const md = formatDigest(snapshot, deltas);

    // TL;DR line
    expect(md).toContain("3 tasks done");
    expect(md).toContain("1 error");
    expect(md).toContain("$2.10");

    // Errors section
    expect(md).toContain("**Errors & Failures**");
    expect(md).toContain("analyze Unity logs");

    // Trigger section
    expect(md).toContain("**Trigger Activity**");
    expect(md).toContain("'Watch Unity scripts' fired 4 times");
    expect(md).toContain("'Daily backup' fired 1 time");

    // Tasks section
    expect(md).toContain("**Tasks**");
    expect(md).toContain("3 completed");
    expect(md).toContain("1 failed");

    // Learning section
    expect(md).toContain("**Learning**");
    expect(md).toContain("2 new instincts");

    // Budget section
    expect(md).toContain("**Budget**");
    expect(md).toContain("$2.10 / $5.00");

    // Goals section
    expect(md).toContain("**Goals**");

    // Dashboard link
    expect(md).toContain("Dashboard: http://localhost:3100");
  });

  it("skips budget section when budget is not configured", () => {
    const snapshot = makeSnapshot({
      tasksCompleted: 1,
      budgetUsed: null,
      budgetLimit: null,
    });

    const md = formatDigest(snapshot, makeDeltas());

    expect(md).not.toContain("**Budget**");
    expect(md).toContain("Dashboard: http://localhost:3100");
  });

  it("skips trigger section when no triggers exist", () => {
    const snapshot = makeSnapshot({
      tasksCompleted: 1,
      triggers: [],
    });

    const md = formatDigest(snapshot, makeDeltas());

    expect(md).not.toContain("**Trigger Activity**");
  });

  it("produces 'All quiet' one-liner when no activity", () => {
    const snapshot = makeSnapshot();
    const deltas = makeDeltas();

    const md = formatDigest(snapshot, deltas);

    expect(md).toContain("All quiet");
    expect(md).toContain("Dashboard: http://localhost:3100");
    // Should not have detailed sections
    expect(md).not.toContain("**Errors & Failures**");
    expect(md).not.toContain("**Trigger Activity**");
    expect(md).not.toContain("**Tasks**");
  });

  it("places errors section BEFORE other sections", () => {
    const snapshot = makeSnapshot({
      errors: [{ message: "Something broke", timestamp: Date.now() }],
      tasksCompleted: 2,
      triggers: [{ name: "Test trigger", fireCount: 1, lastResult: "success" }],
    });

    const md = formatDigest(snapshot, makeDeltas());

    const errorsIdx = md.indexOf("**Errors & Failures**");
    const triggersIdx = md.indexOf("**Trigger Activity**");
    const tasksIdx = md.indexOf("**Tasks**");

    expect(errorsIdx).toBeGreaterThan(-1);
    expect(triggersIdx).toBeGreaterThan(-1);
    expect(tasksIdx).toBeGreaterThan(-1);
    expect(errorsIdx).toBeLessThan(triggersIdx);
    expect(errorsIdx).toBeLessThan(tasksIdx);
  });

  it("uses named triggers with fire counts", () => {
    const snapshot = makeSnapshot({
      triggers: [
        { name: "Watch Unity scripts", fireCount: 4, lastResult: "success" },
      ],
    });

    const md = formatDigest(snapshot, makeDeltas());

    expect(md).toContain("'Watch Unity scripts' fired 4 times");
  });

  it("shows deltas for instincts and budget", () => {
    const snapshot = makeSnapshot({
      tasksCompleted: 5,
      instinctsLearned: 2,
      totalActiveInstincts: 12,
      budgetUsed: 2.1,
      budgetLimit: 5.0,
    });
    const deltas = makeDeltas({
      instinctDelta: 3,
      budgetDelta: 0.85,
      taskDelta: 2,
    });

    const md = formatDigest(snapshot, deltas);

    expect(md).toContain("+3");
    expect(md).toContain("+$0.85");
    expect(md).toContain("+2");
  });
});

// =============================================================================
// truncateForChannel
// =============================================================================

describe("truncateForChannel", () => {
  it("respects Telegram 4096 limit with fallback suffix", () => {
    const longMarkdown = "A".repeat(5000);
    const result = truncateForChannel(longMarkdown, "telegram", "http://localhost:3100");

    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain("... view full details on dashboard");
    expect(result).toContain("http://localhost:3100");
  });

  it("does not truncate for web (unlimited)", () => {
    const longMarkdown = "A".repeat(10000);
    const result = truncateForChannel(longMarkdown, "web", "http://localhost:3100");

    expect(result).toBe(longMarkdown);
  });

  it("does not truncate for CLI (unlimited)", () => {
    const longMarkdown = "A".repeat(10000);
    const result = truncateForChannel(longMarkdown, "cli", "http://localhost:3100");

    expect(result).toBe(longMarkdown);
  });

  it("returns original if within limit", () => {
    const shortMarkdown = "Hello world";
    const result = truncateForChannel(shortMarkdown, "telegram", "http://localhost:3100");

    expect(result).toBe(shortMarkdown);
  });
});

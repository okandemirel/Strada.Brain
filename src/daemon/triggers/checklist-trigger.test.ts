import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChecklistTrigger } from "./checklist-trigger.js";
import type { ChecklistTriggerDef, ChecklistItem } from "../daemon-types.js";

describe("ChecklistTrigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // Helper factory
  // ===========================================================================

  function makeDef(
    items: ChecklistItem[],
    overrides?: Partial<ChecklistTriggerDef>,
  ): ChecklistTriggerDef {
    return {
      type: "checklist",
      name: "test-checklist",
      action: "Review due items",
      items,
      ...overrides,
    };
  }

  function makeItem(
    text: string,
    opts?: Partial<ChecklistItem>,
  ): ChecklistItem {
    return {
      text,
      checked: false,
      priority: "medium",
      ...opts,
    };
  }

  // ===========================================================================
  // Metadata
  // ===========================================================================

  it("metadata has correct name, type, and initial description", () => {
    const trigger = new ChecklistTrigger(makeDef([makeItem("Task A")]));

    expect(trigger.metadata.name).toBe("test-checklist");
    expect(trigger.metadata.type).toBe("checklist");
    expect(trigger.metadata.description).toBe("Review due items");
  });

  // ===========================================================================
  // shouldFire -- unchecked items with matching cron
  // ===========================================================================

  it("shouldFire returns true when unchecked item with matching cron is due", () => {
    // Set time to 9:00 on a Monday
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Daily standup", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("shouldFire returns false when unchecked item cron does not match", () => {
    // Set time to 10:00 -- cron is for 9:00
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Daily standup", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // ===========================================================================
  // shouldFire -- checked items always skipped
  // ===========================================================================

  it("shouldFire returns false for checked items regardless of schedule", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Done task", { checked: true, schedule: "0 9 * * *" }),
      ]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // ===========================================================================
  // shouldFire -- items without schedule fire every evaluation
  // ===========================================================================

  it("items without schedule fire on every evaluation (with minute dedup)", () => {
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Unscheduled task")]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // Double-fire prevention (minute-floor dedup)
  // ===========================================================================

  it("shouldFire returns false after onFired in the same minute", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Daily standup", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);
    trigger.onFired(new Date());

    // 30 seconds later (same minute)
    vi.setSystemTime(new Date("2026-03-09T09:00:30Z"));
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("shouldFire returns true again in the next matching minute", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Every minute task", { schedule: "* * * * *" })]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);
    trigger.onFired(new Date());

    // Next minute
    vi.setSystemTime(new Date("2026-03-09T09:01:00Z"));
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // Multiple due items
  // ===========================================================================

  it("multiple unchecked due items all included in dueItems", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Task A", { schedule: "0 9 * * *" }),
        makeItem("Task B", { schedule: "0 9 * * *" }),
        makeItem("Task C", { schedule: "0 10 * * *" }), // not due
      ]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);

    const due = trigger.getDueItems();
    expect(due).toHaveLength(2);
    expect(due.map((i) => i.text)).toContain("Task A");
    expect(due.map((i) => i.text)).toContain("Task B");
  });

  // ===========================================================================
  // Priority preservation
  // ===========================================================================

  it("priority is preserved in due items (high, medium, low)", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Critical bug", { priority: "high", schedule: "0 9 * * *" }),
        makeItem("Review PR", { priority: "low", schedule: "0 9 * * *" }),
      ]),
      "UTC",
    );

    trigger.shouldFire(new Date());
    const due = trigger.getDueItems();
    expect(due[0]!.priority).toBe("high");
    expect(due[1]!.priority).toBe("low");
  });

  // ===========================================================================
  // onFired -- description update
  // ===========================================================================

  it("onFired updates description with due item list and priorities", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Fix login bug", { priority: "high", schedule: "0 9 * * *" }),
        makeItem("Review PR queue", {
          priority: "medium",
          schedule: "0 9 * * *",
        }),
      ]),
      "UTC",
    );

    trigger.shouldFire(new Date());
    trigger.onFired(new Date());

    const desc = trigger.metadata.description;
    expect(desc).toContain("Checklist items due");
    expect(desc).toContain("[high] Fix login bug");
    expect(desc).toContain("[medium] Review PR queue");
  });

  // ===========================================================================
  // getNextRun
  // ===========================================================================

  it("getNextRun returns earliest scheduled time across unchecked items", () => {
    vi.setSystemTime(new Date("2026-03-09T08:30:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("First", { schedule: "0 10 * * *" }), // 10:00
        makeItem("Second", { schedule: "0 9 * * *" }), // 9:00 -- earliest
      ]),
      "UTC",
    );

    const nextRun = trigger.getNextRun();
    expect(nextRun).not.toBeNull();
    expect(nextRun!.getUTCHours()).toBe(9);
  });

  it("getNextRun returns null when no items have schedules", () => {
    vi.setSystemTime(new Date("2026-03-09T08:30:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Unscheduled")]),
      "UTC",
    );

    expect(trigger.getNextRun()).toBeNull();
  });

  it("getNextRun skips checked items", () => {
    vi.setSystemTime(new Date("2026-03-09T08:30:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Done", { checked: true, schedule: "0 9 * * *" }),
        makeItem("Active", { schedule: "0 10 * * *" }),
      ]),
      "UTC",
    );

    const nextRun = trigger.getNextRun();
    expect(nextRun).not.toBeNull();
    expect(nextRun!.getUTCHours()).toBe(10);
  });

  // ===========================================================================
  // getState
  // ===========================================================================

  it("getState returns active", () => {
    const trigger = new ChecklistTrigger(makeDef([]));
    expect(trigger.getState()).toBe("active");
  });

  // ===========================================================================
  // dispose
  // ===========================================================================

  it("dispose is a no-op and does not throw", async () => {
    const trigger = new ChecklistTrigger(makeDef([]));
    await expect(trigger.dispose()).resolves.toBeUndefined();
  });

  // ===========================================================================
  // Empty/all-checked edge cases
  // ===========================================================================

  it("empty items list: shouldFire always returns false", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(makeDef([]), "UTC");
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("all items checked: shouldFire always returns false", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("A", { checked: true, schedule: "0 9 * * *" }),
        makeItem("B", { checked: true }),
      ]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // ===========================================================================
  // Mixed items
  // ===========================================================================

  it("mixed items: fires for unchecked items only", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Checked with schedule", {
          checked: true,
          schedule: "0 9 * * *",
        }),
        makeItem("Unchecked with schedule", { schedule: "0 9 * * *" }),
        makeItem("Checked no schedule", { checked: true }),
        makeItem("Unchecked no schedule"),
      ]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);

    const due = trigger.getDueItems();
    expect(due).toHaveLength(2);
    expect(due.map((i) => i.text)).toEqual([
      "Unchecked with schedule",
      "Unchecked no schedule",
    ]);
  });

  // ===========================================================================
  // updateItems
  // ===========================================================================

  it("updateItems replaces items and rebuilds cron map", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Old task", { schedule: "0 10 * * *" })]),
      "UTC",
    );

    // Old item not due at 9:00
    expect(trigger.shouldFire(new Date())).toBe(false);

    // Replace with a new item that IS due at 9:00
    trigger.updateItems([makeItem("New task", { schedule: "0 9 * * *" })]);

    expect(trigger.shouldFire(new Date())).toBe(true);
    const due = trigger.getDueItems();
    expect(due[0]!.text).toBe("New task");
  });

  it("updateItems clears lastFired tracking", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Task", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    trigger.shouldFire(new Date());
    trigger.onFired(new Date());

    // Same minute -- should be deduped
    expect(trigger.shouldFire(new Date())).toBe(false);

    // updateItems resets the dedup map
    trigger.updateItems([makeItem("Task", { schedule: "0 9 * * *" })]);
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // Timezone
  // ===========================================================================

  it("timezone support: items fire at correct local time", () => {
    // 09:00 UTC = 12:00 Istanbul
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Istanbul noon task", { schedule: "0 12 * * *" }),
      ]),
      "Europe/Istanbul",
    );

    // At 09:00 UTC which is 12:00 Istanbul, should fire
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  it("timezone: item does not fire at wrong local time", () => {
    // 08:00 UTC = 11:00 Istanbul
    vi.setSystemTime(new Date("2026-03-09T08:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Istanbul noon task", { schedule: "0 12 * * *" }),
      ]),
      "Europe/Istanbul",
    );

    // At 08:00 UTC which is 11:00 Istanbul, should NOT fire
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // ===========================================================================
  // getDueItems returns readonly array
  // ===========================================================================

  it("getDueItems returns empty array when no items are due", () => {
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Not due", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    trigger.shouldFire(new Date());
    expect(trigger.getDueItems()).toHaveLength(0);
  });

  // ===========================================================================
  // Unscheduled items fire only once (text-key dedup)
  // ===========================================================================

  it("unscheduled items fire only once even across different minutes", () => {
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("One-shot task")]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);
    trigger.onFired(new Date());

    // Move to next minute -- unscheduled items should NOT fire again
    vi.setSystemTime(new Date("2026-03-09T10:01:00Z"));
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("unscheduled items fire again after updateItems resets tracking", () => {
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Repeatable after update")]),
      "UTC",
    );

    expect(trigger.shouldFire(new Date())).toBe(true);
    trigger.onFired(new Date());

    // Move to next minute
    vi.setSystemTime(new Date("2026-03-09T10:01:00Z"));
    expect(trigger.shouldFire(new Date())).toBe(false);

    // updateItems resets tracking, so the item fires again
    trigger.updateItems([makeItem("Repeatable after update")]);
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // ===========================================================================
  // onFired with no due items is a no-op
  // ===========================================================================

  it("onFired with no due items does not change description", () => {
    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Not due", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    const descBefore = trigger.metadata.description;
    trigger.shouldFire(new Date());
    trigger.onFired(new Date());
    expect(trigger.metadata.description).toBe(descBefore);
  });

  // ===========================================================================
  // updateItems clears dueItems
  // ===========================================================================

  it("updateItems resets dueItems to empty", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([makeItem("Task", { schedule: "0 9 * * *" })]),
      "UTC",
    );

    trigger.shouldFire(new Date());
    expect(trigger.getDueItems()).toHaveLength(1);

    trigger.updateItems([]);
    expect(trigger.getDueItems()).toHaveLength(0);
  });

  // ===========================================================================
  // getNextRun with all items checked returns null
  // ===========================================================================

  it("getNextRun returns null when all scheduled items are checked", () => {
    vi.setSystemTime(new Date("2026-03-09T08:30:00Z"));

    const trigger = new ChecklistTrigger(
      makeDef([
        makeItem("Done A", { checked: true, schedule: "0 9 * * *" }),
        makeItem("Done B", { checked: true, schedule: "0 10 * * *" }),
      ]),
      "UTC",
    );

    expect(trigger.getNextRun()).toBeNull();
  });
});

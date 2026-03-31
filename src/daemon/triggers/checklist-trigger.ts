/**
 * ChecklistTrigger
 *
 * Implements ITrigger for evaluating checklist items from HEARTBEAT.md.
 * Each unchecked item can have an optional cron schedule -- items without
 * a schedule fire on every evaluation. Minute-floor deduplication prevents
 * double-fire within the same minute (same pattern as CronTrigger).
 *
 * The trigger provides a getDueItems() accessor for Plan 03 event payloads
 * and an updateItems() method for hot-reloading the checklist.
 *
 * Used by: TriggerRegistry, HeartbeatLoop
 */

import { Cron } from "croner";
import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
  ChecklistTriggerDef,
  ChecklistItem,
} from "../daemon-types.js";
import { floorToMinute } from "./trigger-utils.js";

export class ChecklistTrigger implements ITrigger {
  private _metadata: TriggerMetadata;
  private readonly originalAction: string;
  private readonly timezone: string;
  private items: ChecklistItem[];
  private itemCrons: Map<number, Cron>;
  private lastFiredMinute: Map<number | string, number>;
  private dueItems: ChecklistItem[];

  /**
   * @param def Checklist trigger definition parsed from HEARTBEAT.md
   * @param timezone IANA timezone string (e.g., "UTC", "Europe/Istanbul")
   */
  constructor(def: ChecklistTriggerDef, timezone?: string) {
    this.originalAction = def.action;
    this._metadata = {
      name: def.name,
      description: def.action,
      type: "checklist",
    };

    this.timezone =
      timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.items = [...def.items];
    this.dueItems = [];
    this.lastFiredMinute = new Map();
    this.itemCrons = new Map();

    this.buildCronMap();
  }

  /**
   * Build Cron instances for all unchecked items that have a schedule.
   * Called from constructor and updateItems().
   */
  private buildCronMap(): void {
    this.itemCrons.clear();

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (!item.checked && item.schedule) {
        this.itemCrons.set(
          i,
          new Cron(item.schedule, {
            timezone: this.timezone,
            paused: true,
          }),
        );
      }
    }
  }

  /**
   * ITrigger.metadata -- dynamic getter allows description to change after onFired.
   */
  get metadata(): TriggerMetadata {
    return this._metadata;
  }

  /**
   * Check if any unchecked items are due at the given time.
   *
   * For items with a cron schedule: checks if the cron matches `now`.
   * For items without a schedule: always considered due.
   * Both are subject to minute-floor dedup to prevent double-fire.
   */
  shouldFire(now: Date): boolean {
    const minuteFloor = floorToMinute(now);
    this.dueItems = [];

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;

      // Skip checked items
      if (item.checked) continue;

      // Skip if already fired in this minute (dedup)
      if (this.lastFiredMinute.get(i) === minuteFloor) continue;

      if (item.schedule) {
        // Scheduled item: check cron match
        const cron = this.itemCrons.get(i);
        if (cron && cron.match(now)) {
          this.dueItems.push(item);
        }
      } else {
        // Unscheduled item: fire once only
        if (!this.lastFiredMinute.has(item.text)) {
          this.dueItems.push(item);
        }
      }
    }

    return this.dueItems.length > 0;
  }

  /**
   * Called after the trigger fires. Records fire time per due item
   * and updates metadata description with the due item list.
   */
  onFired(now: Date): void {
    const minuteFloor = floorToMinute(now);

    // Record fire minute for each due item (by finding its index)
    for (const dueItem of this.dueItems) {
      const idx = this.items.indexOf(dueItem);
      if (idx !== -1) {
        this.lastFiredMinute.set(idx, minuteFloor);
      }
      // Mark unscheduled items as fired (text key) so they only fire once
      if (!dueItem.schedule) {
        this.lastFiredMinute.set(dueItem.text, minuteFloor);
      }
    }

    // Build dynamic description
    if (this.dueItems.length > 0) {
      const itemList = this.dueItems
        .map((item) => `[${item.priority}] ${item.text}`)
        .join(", ");

      this._metadata = {
        name: this._metadata.name,
        description: `Checklist items due: ${itemList}. Action: ${this.originalAction}`,
        type: this._metadata.type,
      };
    }
  }

  /**
   * Get the next scheduled fire time across all unchecked items.
   * Returns null if no items have schedules or all scheduled items are checked.
   */
  getNextRun(): Date | null {
    let earliest: Date | null = null;

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (item.checked || !item.schedule) continue;

      const cron = this.itemCrons.get(i);
      if (!cron) continue;

      const next = cron.nextRun();
      if (next && (!earliest || next.getTime() < earliest.getTime())) {
        earliest = next;
      }
    }

    return earliest;
  }

  /**
   * Always returns 'active'. Circuit breaker state is managed externally
   * by HeartbeatLoop.
   */
  getState(): TriggerState {
    return "active";
  }

  /**
   * Get the items determined to be due in the last shouldFire() call.
   * Useful for event payload construction in Plan 03.
   */
  getDueItems(): ReadonlyArray<ChecklistItem> {
    return this.dueItems;
  }

  /**
   * Replace the internal items array and rebuild the cron map.
   * Used for hot-reloading checklist items when HEARTBEAT.md changes.
   */
  updateItems(items: ChecklistItem[]): void {
    this.items = [...items];
    this.lastFiredMinute.clear();
    this.buildCronMap();
    this.dueItems = [];
  }

  /**
   * No-op -- ChecklistTrigger holds no external resources.
   * Cron instances are lightweight and garbage-collected.
   */
  async dispose(): Promise<void> {
    // intentional no-op
  }
}

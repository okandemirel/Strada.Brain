/**
 * ChecklistTrigger
 *
 * Implements ITrigger for evaluating checklist items from HEARTBEAT.md.
 * Each unchecked item can have an optional cron schedule -- a scheduled item
 * fires once per occurrence (isOccurrenceDue, shared with CronTrigger), an item
 * without a schedule fires once. Minute-floor deduplication prevents
 * double-fire within the same minute (same pattern as CronTrigger).
 *
 * The trigger provides a getDueItems() accessor for Plan 03 event payloads
 * and an updateItems() method for hot-reloading the checklist.
 *
 * Used by: TriggerRegistry, HeartbeatLoop
 */

import { createHash } from "node:crypto";
import { Cron } from "croner";
import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
  ChecklistTriggerDef,
  ChecklistItem,
  TriggerStateStore,
} from "../daemon-types.js";
import { floorToMinute, isOccurrenceDue } from "./trigger-utils.js";

export class ChecklistTrigger implements ITrigger {
  private _metadata: TriggerMetadata;
  private readonly originalAction: string;
  private readonly timezone: string;
  private items: ChecklistItem[];
  private itemCrons: Map<number, Cron>;
  /** Per scheduled item: the previous evaluation, so an occurrence since then is due. */
  private itemLastChecked = new Map<number, Date>();
  /** itemLastChecked before the latest look, to give a consumed occurrence back. */
  private checkedBeforeLastLook = new Map<number, Date>();
  private lastFiredMinute: Map<number | string, number>;
  private stateStore?: TriggerStateStore;
  private dueItems: ChecklistItem[];

  /**
   * @param def Checklist trigger definition parsed from HEARTBEAT.md
   * @param timezone IANA timezone string (e.g., "UTC", "Europe/Istanbul")
   */
  constructor(def: ChecklistTriggerDef, timezone?: string) {
    this.originalAction = def.action;
    // cooldownSeconds: the parsed HEARTBEAT.md cooldown was dropped here before
    // (audited 2026-09-02) — only CronTrigger ever received it.
    this._metadata = {
      name: def.name,
      description: def.action,
      type: "checklist",
      cooldownSeconds: def.cooldown,
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
    this.itemLastChecked.clear();
    const builtAt = new Date();

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
        this.itemLastChecked.set(i, builtAt);
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
   * For items with a cron schedule: due when an occurrence fell since the
   * previous evaluation (not only when `now` is second :00 of it).
   * For items without a schedule: always considered due.
   * Both are subject to minute-floor dedup to prevent double-fire.
   */
  shouldFire(now: Date): boolean {
    const minuteFloor = floorToMinute(now);
    this.dueItems = [];
    this.checkedBeforeLastLook = new Map();

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;

      // Skip checked items
      if (item.checked) continue;

      // Skip if already fired in this minute (dedup)
      if (this.lastFiredMinute.get(i) === minuteFloor) continue;

      if (item.schedule) {
        // Scheduled item. `cron.match(now)` matched only when a tick landed
        // in second :00 of the occurrence, so a drifting heartbeat almost
        // never fired it; look for an occurrence since the previous look
        // instead, and advance the look on every evaluation.
        const cron = this.itemCrons.get(i);
        if (!cron) continue;
        const since = this.itemLastChecked.get(i) ?? now;
        this.checkedBeforeLastLook.set(i, since);
        this.itemLastChecked.set(i, now);
        if (isOccurrenceDue(cron, since, now)) {
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
  /** The items the last onFired marked as done, in case it never became work. */
  private consumedByLastFire: ChecklistItem[] = [];
  /** The look-back each consumed scheduled item had before that fire. */
  private consumedLookBack = new Map<number, Date>();

  onFired(now: Date): void {
    const minuteFloor = floorToMinute(now);

    // Record fire minute for each due item (by finding its index)
    for (const dueItem of this.dueItems) {
      const idx = this.items.indexOf(dueItem);
      if (idx !== -1) {
        this.lastFiredMinute.set(idx, minuteFloor);
      }
      // Mark unscheduled items as fired (text key) so they only fire once —
      // durably: an in-memory mark fired the item again on every restart.
      if (!dueItem.schedule) {
        this.lastFiredMinute.set(dueItem.text, minuteFloor);
        this.stateStore?.set(firedKey(dueItem.text), String(minuteFloor));
      }
    }

    // Build dynamic description
    if (this.dueItems.length > 0) {
      // Spread keeps cooldownSeconds across the rebuild (audited 2026-09-02)
      this._metadata = { ...this._metadata, description: this.buildSummary() };
    }
    // WHAT THIS FIRE CONSUMED, so it can be given back if the fire never
    // became work (Codex 2026-09-13 AG#12).
    this.consumedByLastFire = [...this.dueItems];
    this.consumedLookBack = new Map(this.checkedBeforeLastLook);
  }

  /**
   * The submission threw: an item this fire consumed is due again. Without this the item was gone — marked fired, never run.
   */
  onSubmitFailed(_now: Date): void {
    for (const item of this.consumedByLastFire) {
      const idx = this.items.indexOf(item);
      if (idx !== -1) {
        this.lastFiredMinute.delete(idx);
        // A scheduled item's occurrence is due again on the next look.
        const lookBack = this.consumedLookBack.get(idx);
        if (item.schedule && lookBack) this.itemLastChecked.set(idx, lookBack);
      }
      if (!item.schedule) {
        this.lastFiredMinute.delete(item.text);
        this.stateStore?.delete(firedKey(item.text));
      }
    }
  }

  /**
   * ITrigger.previewFireDescription -- what onFired would publish for the
   * items shouldFire() just found due, with no side effects (nothing recorded
   * as fired, metadata untouched), so content dedup judges this fire
   * (audited 2026-09-02).
   */
  previewFireDescription(_now: Date): string {
    if (this.dueItems.length === 0) return this._metadata.description;
    return this.buildSummary();
  }

  /** Summary of the due items; pure. */
  private buildSummary(): string {
    const itemList = this.dueItems
      .map((item) => `[${item.priority}] ${item.text}`)
      .join(", ");
    return `Checklist items due: ${itemList}. Action: ${this.originalAction}`;
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
    this.restoreFiredItems();
    this.buildCronMap();
    this.dueItems = [];
  }

  /** Load which unscheduled items a previous process already fired. */
  attachStateStore(store: TriggerStateStore): void {
    this.stateStore = store;
    this.restoreFiredItems();
  }

  private restoreFiredItems(): void {
    if (!this.stateStore) return;
    for (const item of this.items) {
      if (item.checked || item.schedule) continue;
      const fired = this.stateStore.get(firedKey(item.text));
      if (fired !== undefined) this.lastFiredMinute.set(item.text, Number(fired));
    }
  }

  /**
   * No-op -- ChecklistTrigger holds no external resources.
   * Cron instances are lightweight and garbage-collected.
   */
  async dispose(): Promise<void> {
    // intentional no-op
  }
}

/** State key for an unscheduled item's "fired once" mark (hashed: item text is free-form). */
function firedKey(text: string): string {
  return `fired:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

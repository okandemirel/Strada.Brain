/**
 * TriggerRegistry
 *
 * Manages the lifecycle of registered triggers: register, unregister,
 * lookup by name, list all, list active (non-disabled), clear.
 *
 * The registry is designed to be extensible for Phase 15's FileWatchTrigger,
 * WebhookTrigger, and ChecklistTrigger -- any class implementing ITrigger
 * can be registered.
 *
 * Used by: HeartbeatLoop (Plan 04), Daemon CLI (Plan 05)
 */

import type { ITrigger } from "./daemon-types.js";

export class TriggerRegistry {
  private readonly triggers = new Map<string, ITrigger>();

  /**
   * Register a trigger. Throws if a trigger with the same name already exists.
   */
  register(trigger: ITrigger): void {
    const name = trigger.metadata.name;
    if (this.triggers.has(name)) {
      throw new Error(`Trigger '${name}' is already registered`);
    }
    this.triggers.set(name, trigger);
  }

  /**
   * Unregister a trigger by name.
   */
  unregister(name: string): void {
    this.triggers.delete(name);
  }

  /**
   * Look up a trigger by name.
   */
  getByName(name: string): ITrigger | undefined {
    return this.triggers.get(name);
  }

  /**
   * Get all registered triggers.
   */
  getAll(): ITrigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get only active (non-disabled) triggers.
   * Includes active, paused, and backed_off -- excludes only 'disabled'.
   */
  getActive(): ITrigger[] {
    return this.getAll().filter((t) => t.getState() !== "disabled");
  }

  /**
   * Remove all registered triggers.
   */
  clear(): void {
    this.triggers.clear();
  }

  /**
   * Get the current number of registered triggers.
   */
  count(): number {
    return this.triggers.size;
  }
}

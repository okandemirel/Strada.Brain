// ---------------------------------------------------------------------------
// Per-skill environment variable injection with snapshot/restore.
// ---------------------------------------------------------------------------

/**
 * Manages per-skill environment variable injection.
 *
 * Before overwriting `process.env` keys, it snapshots their current values
 * so they can be restored when the skill is unloaded.
 */
export class SkillEnvInjector {
  /** Map<skillName, Map<envKey, previousValue | undefined>> */
  private snapshots = new Map<string, Map<string, string | undefined>>();

  /**
   * Inject environment variables for a skill.
   * Existing values are snapshotted before being overwritten.
   * Calling inject() again for the same skill replaces the previous snapshot.
   */
  inject(skillName: string, env: Record<string, string>): void {
    const snapshot = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(env)) {
      // Snapshot current value (may be undefined if not previously set)
      snapshot.set(key, process.env[key]);
      process.env[key] = value;
    }

    this.snapshots.set(skillName, snapshot);
  }

  /**
   * Restore environment variables that were overwritten by `inject()`.
   * Keys that were previously undefined are deleted from `process.env`.
   */
  restore(skillName: string): void {
    const snapshot = this.snapshots.get(skillName);
    if (!snapshot) return;

    for (const [key, previousValue] of snapshot) {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }

    this.snapshots.delete(skillName);
  }

  /**
   * Check if a skill currently has injected environment variables.
   */
  hasSnapshot(skillName: string): boolean {
    return this.snapshots.has(skillName);
  }
}

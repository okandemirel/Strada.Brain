// ---------------------------------------------------------------------------
// Per-skill environment variable injection with owner-aware rollback.
//
// Codex round 6 #9 (2026-09-17): the previous snapshot/restore stored, per
// skill, "the value before I wrote". With skill A injecting X=a and skill B
// then injecting X=b, restoring A out of order put X back to the pre-A value
// and clobbered B; disposing B afterwards "restored" X to "a". The variable
// is now an overlay stack: every owner records what it set, and removing an
// owner recomputes the variable from the overlays that remain (the original
// value when none does), whatever the removal order.
// ---------------------------------------------------------------------------

interface Overlay {
  readonly owner: string;
  readonly value: string;
}

interface VariableState {
  /** The value before the first owner touched it (`undefined` = not set). */
  readonly original: string | undefined;
  /** Owners in injection order; the last one is what `process.env` shows. */
  overlays: Overlay[];
}

/**
 * Manages per-skill environment variable injection.
 *
 * Each owner (skill) contributes an overlay per variable it sets. The
 * effective value is the most recently injected overlay still present; when
 * the last overlay of a variable is removed, the original value is restored
 * (deleted when it was not set before).
 */
export class SkillEnvInjector {
  /** envKey → its original value + overlay stack */
  private readonly variables = new Map<string, VariableState>();
  /** owner → the keys it currently overlays */
  private readonly owners = new Map<string, Set<string>>();

  /**
   * Inject environment variables for a skill. Calling inject() again for the
   * same owner replaces its previous overlays (they are removed first).
   */
  inject(owner: string, env: Record<string, string>): void {
    if (this.owners.has(owner)) this.restore(owner);

    const keys = new Set<string>();
    for (const [key, value] of Object.entries(env)) {
      let state = this.variables.get(key);
      if (!state) {
        state = { original: process.env[key], overlays: [] };
        this.variables.set(key, state);
      }
      state.overlays.push({ owner, value });
      process.env[key] = value;
      keys.add(key);
    }
    this.owners.set(owner, keys);
  }

  /**
   * Remove an owner's overlays. Every variable it touched is recomputed from
   * the remaining overlays; a variable with none left returns to its original
   * value (deleted when it was previously undefined).
   */
  restore(owner: string): void {
    const keys = this.owners.get(owner);
    if (!keys) return;

    for (const key of keys) {
      const state = this.variables.get(key);
      if (!state) continue;
      state.overlays = state.overlays.filter((overlay) => overlay.owner !== owner);
      const top = state.overlays[state.overlays.length - 1];
      if (top) {
        process.env[key] = top.value;
        continue;
      }
      if (state.original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = state.original;
      }
      this.variables.delete(key);
    }

    this.owners.delete(owner);
  }

  /**
   * Check if a skill currently has injected environment variables.
   */
  hasSnapshot(owner: string): boolean {
    return this.owners.has(owner);
  }
}

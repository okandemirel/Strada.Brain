/**
 * Typed setup persistence: MERGE the wizard's output into the existing .env
 * instead of rewriting the whole file (plan 2.1, audit 10.1b / D24, D29-D30).
 *
 * The writer is declared in common, the foundation layer, because config's
 * `preset set` writes the .env through it too. This file re-exports it so the
 * wizard, the doctor, their tests and the first-run rehearsal keep their path.
 */

export {
  formatEnvValue,
  parseEnvLines,
  mergeEnvContent,
  ENV_SAVE_LOCK,
  removeLockIfUnchanged,
  __testing,
  recoverAbandonedLock,
  persistSetup,
  redactEffectiveConfig,
  describeEffectiveBudget,
} from "../common/setup-env-persistence.js";
export type {
  EnvUpdateEntry,
  PersistSetupOptions,
  MergeEnvResult,
  PersistSetupResult,
  LockRecovery,
  EffectiveBudget,
} from "../common/setup-env-persistence.js";

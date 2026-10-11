/**
 * Settings a release stopped reading.
 *
 * They were documented, parsed and range-checked long after their reader was
 * gone, so an operator who tuned one changed nothing, and an out-of-range value
 * refused the boot over a setting no code used. They are out of the schema now;
 * a boot that still finds one set names it instead of ignoring it.
 */

const GOAL_EXECUTOR_GONE =
  "the goal executor that read it was folded into the supervisor. Tune SUPERVISOR_MAX_PARALLEL_NODES and SUPERVISOR_MAX_FAILURE_BUDGET instead.";

const RETIRED_SETTINGS: ReadonlyMap<string, string> = new Map([
  ["GOAL_MAX_RETRIES", GOAL_EXECUTOR_GONE],
  ["GOAL_MAX_FAILURES", GOAL_EXECUTOR_GONE],
  ["GOAL_PARALLEL_EXECUTION", GOAL_EXECUTOR_GONE],
  ["GOAL_MAX_PARALLEL", GOAL_EXECUTOR_GONE],
  ["STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES", GOAL_EXECUTOR_GONE],
  ["STRADA_GOAL_MAX_REDECOMPOSITIONS", GOAL_EXECUTOR_GONE],
  [
    "STRADA_VAULT_EMBEDDING_FALLBACK",
    "the vault always builds; without an embedding provider it indexes with a hash embedder, and its vector store is non-semantic, so retrieval is lexical either way.",
  ],
]);

/** The retired settings `env` sets to a non-empty value, in declaration order. */
export function findRetiredSettings(env: Readonly<Record<string, string | undefined>>): string[] {
  return [...RETIRED_SETTINGS.keys()].filter((name) => (env[name] ?? "").trim() !== "");
}

/** The startup notice for one retired setting. */
export function describeRetiredSetting(name: string): string {
  const reason = RETIRED_SETTINGS.get(name) ?? "nothing reads it.";
  return `${name} is set but no longer read: ${reason} Remove it from .env.`;
}

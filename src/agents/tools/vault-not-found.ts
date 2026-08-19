/**
 * A miss the caller can act on.
 *
 * "vault not found: self" tells an agent nothing it can use — it does not know
 * what the ids look like, so its next guess is no better informed than its
 * first. Naming the registered ids turns a dead end into one correction.
 */
export function vaultNotFound(requested: string, registered: readonly string[]): string {
  if (registered.length === 0) return `vault not found: ${requested} (none registered)`;
  return `vault not found: ${requested} — registered: ${registered.join(', ')}`;
}
